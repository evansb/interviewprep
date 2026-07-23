# Chapter 41 — Assembly, Binaries, and ABI

An application binary interface (ABI) is the contract that lets separately compiled code interoperate. C++ defines the program; an ISA defines instructions; an ABI defines calls and object-level conventions; an object format and operating system define linking and loading. Keeping those layers separate is the central discipline of this chapter.

---

## The 90-Second Screen — Core

When handed a disassembly or crash address:

1. Name the context: ISA, syntax, object format, OS, ABI, compiler, and build flags. A SysV AMD64 register rule is not a C++ guarantee and is not the Windows x64 rule.
2. Find the function boundary, arguments, returns, calls, backward branches, and memory operands. Correlate addresses with source and samples before optimizing.
3. At a call boundary, distinguish caller-saved from callee-saved registers, check stack alignment, and recognize hidden aggregate-return or indirect-parameter conventions.
4. A reliable stack trace needs either an intact frame-pointer chain or correct unwind metadata. Inlining and tail calls change the logical call stack.
5. In ELF, sections are primarily the linker's view; program segments are the loader's view. Symbols name entities; relocations describe address fixups.
6. PIC usually reaches internal data PC-relatively and preemptible data through a GOT. Imported calls may use a PLT and lazy or eager binding.
7. Debug information maps machine addresses back to source. Preserve build IDs and matching symbols for the exact deployed binary.
8. Diagnose from evidence: source → compiler output → object symbols/relocations → linked image → loader decisions → sampled instruction.

Chapter 1 covers translation units, linkage, the ODR, and `extern "C"`. This chapter follows those language concepts across the binary boundary.

---

## 41.1 Reading Machine Code and x86-64 Assembly — Core

Machine code is bytes interpreted by an ISA. Assembly is a textual representation chosen by a disassembler; labels and symbol names may not exist in a stripped binary. The goal is not to memorize an instruction catalog, but to follow values, control flow, and memory traffic.

**First: know which syntax you are looking at.**

| | AT&T (GNU default) | Intel (MSVC, most documentation) |
|---|---|---|
| Operand order | `mov src, dst` | `mov dst, src` |
| Registers | `%rax` | `rax` |
| Immediates | `$42` | `42` |
| Memory | `disp(base, index, scale)` → `8(%rax,%rbx,4)` | `[base + index*scale + disp]` → `[rax + rbx*4 + 8]` |
| Size suffix | `movq`, `movl`, `movb` | Implied by register, or `qword ptr` |

Use `objdump -d -M intel` or `gcc -S -masm=intel` if Intel syntax is easier for you; the important thing is consistency. All examples below are Intel syntax.

**The reading procedure**, applied to a function:

1. **Find the entry and stack adjustment.** `push rbp; mov rbp, rsp; sub rsp, N` is one possible frame-pointer prologue; optimized functions may omit it. `N` covers some mixture of locals, spills, alignment, and outgoing-call space.
2. **Map arguments to registers** by the SysV order (§41.5): `rdi, rsi, rdx, rcx, r8, r9` for integers/pointers, `xmm0–7` for floating point.
3. **Identify the loop.** Look for a backward jump to a label above it. The instructions between the label and the jump are the loop body; count them.
4. **Classify memory traffic.** `mov reg, [mem]` is a load, `mov [mem], reg` a store. Loads from `[rsp+N]` or `[rbp-N]` inside a loop are **spills** — a red flag.
5. **Find the calls.** A surviving `call` is a real call in this binary. An indirect `call [rax]` or `blr xN` may be virtual dispatch, a function pointer, or a linkage stub; inspect how its target was produced.
6. **Check data width.** Vector registers do not by themselves prove loop vectorization, and a scalar instruction does not prove that the entire loop is scalar. Read the loop body and lane width.

### Worked reading: one loop

```cpp
#include <cstddef>

extern "C" int sum(const int* a, std::size_t n) {
    int result = 0;
    for (std::size_t i = 0; i < n; ++i) result += a[i];
    return result;
}
```

One reproducible way to keep this teaching output scalar is:

```bash
clang++ -std=c++23 -O1 -fno-vectorize -fno-slp-vectorize \
  -fno-unroll-loops -S -masm=intel sum.cpp -o sum.s
```

A representative SysV AMD64 body is:

```asm
sum:
        xor     eax, eax          ; result = 0     (xor is the idiomatic zero)
        test    rsi, rsi          ; n == 0 ?
        je      .done
        xor     ecx, ecx          ; i = 0
.loop:
        add     eax, [rdi+rcx*4]  ; result += a[i]  — scaled-index addressing
        inc     rcx
        cmp     rcx, rsi
        jb      .loop             ; backward jump = the loop
.done:
        ret
```

Map `a → rdi`, `n → rsi`, and the integer result → `eax`. `rcx` is the induction variable. `[rdi+rcx*4]` is the only source-array load, `cmp`/`jb` forms the unsigned loop condition, and no stack adjustment means the function needs no local frame. A different compiler version may use `jne`, pointer induction, unrolling, or SIMD while preserving the same C++ behavior.

**Reading tips that save time:**

- Compilers commonly make the predicted or profiled hot path the fall-through, but this is a heuristic rather than an ABI rule (Ch. 40 §40.4).
- `nop` and multi-byte NOP sequences often provide alignment or patching space.
  They can still execute on a fall-through path, so confirm control flow rather
  than assuming every NOP is irrelevant.
- In legacy SSE names, `addss` operates on one scalar float and `addps` on packed floats. AVX/AVX-512 forms and element counts depend on operand width.
- `%rip`-relative addressing (`lea rax, [rip+0x2f31]`) is how PIC references globals (§41.12).
- Sizes: register name tells you the width — `rax` (64), `eax` (32), `ax` (16), `al` (8).

**Tools:** `objdump -d`, `gcc -S`, `perf annotate` (assembly with per-instruction sample counts), and Compiler Explorer (Ch. 44 §44.3) with source↔asm color mapping. Match the tool to the question and validate on the shipped target.

---

## 41.2 x86-64 Registers, Flags, and Addressing — Core

### General-purpose registers

The base x86-64 ISA exposes 16 general-purpose registers. The table uses SysV AMD64 conventional roles; Windows x64 assigns arguments and preservation differently.

| 64 | 32 | 16 | 8 (low) | Conventional use (SysV) |
|---|---|---|---|---|
| `rax` | `eax` | `ax` | `al` | Return value; `mul`/`div` implicit operand; varargs FP count |
| `rbx` | `ebx` | `bx` | `bl` | **Callee-saved** |
| `rcx` | `ecx` | `cx` | `cl` | 4th integer arg; shift count |
| `rdx` | `edx` | `dx` | `dl` | 3rd integer arg; high half of return |
| `rsi` | `esi` | `si` | `sil` | 2nd integer arg; string source |
| `rdi` | `edi` | `di` | `dil` | 1st integer arg; string destination |
| `rbp` | `ebp` | `bp` | `bpl` | **Callee-saved**; frame pointer if used |
| `rsp` | `esp` | `sp` | `spl` | **Stack pointer** |
| `r8`–`r11` | `r8d`… | `r8w`… | `r8b`… | `r8`,`r9` = 5th/6th args; all caller-saved |
| `r12`–`r15` | `r12d`… | | | **Callee-saved** |

**The 32-bit zero-extension rule is the most-asked register detail:** writing to a 32-bit register **zeroes the upper 32 bits** of the 64-bit register. Writing to a 16- or 8-bit register does *not* — it merges, creating a possible target-dependent false dependency on the previous value (Ch. 42 §42.9). Consequences:

- `xor eax, eax` is a compact zeroing idiom and is recognized specially by many x86 microarchitectures.
- `mov eax, edi` is a legitimate zero-extending 32→64 move; `movzx`/`movsx` are needed for narrower widths.
- Partial-register writes (`mov al, 1`) followed by wider reads can create merge work or false dependencies on some cores. Prefer a full-width-producing instruction such as `movzx eax, byte ptr [..]` when it expresses the intended value.

**Vector registers:** `xmm0–15` (128-bit, SSE), extended to `ymm0–15` (256-bit, AVX) and `zmm0–31` (512-bit, AVX-512, which also adds `xmm16–31` and the mask registers `k0–k7`). `xmm0` returns floating-point values; `xmm0–7` pass FP arguments.

### RFLAGS

Set by arithmetic/logic and consumed by conditional jumps, `setcc`, and `cmov`:

| Flag | Meaning | Common test |
|---|---|---|
| ZF | Result was zero | `je`/`jz`, `jne`/`jnz` |
| SF | Sign (top bit) | `js`, `jns` |
| CF | Carry / unsigned overflow-borrow | `jb`/`jae` (**unsigned** comparisons) |
| OF | Signed overflow | `jo`, and `jl`/`jge` (**signed** comparisons) |
| PF | Parity of low byte | rarely used |
| AF | Auxiliary carry | mainly legacy/BCD uses; rarely relevant in compiler output |

**Unsigned vs signed jumps are a reliable reading cue:** `jb`/`ja`/`jbe`/`jae` (below/above) implement **unsigned** conditions; `jl`/`jg`/`jle`/`jge` (less/greater) implement **signed** conditions. Spotting a `jb` where you expected a signed compare is evidence to inspect conversions (Ch. 2 §§2.15–2.18), not a unique reconstruction of the source.

Note `test rax, rax` is the idiomatic "is it zero/null" (cheaper encoding than `cmp rax, 0`), and `cmp` is a `sub` that discards its result.

### Addressing modes

One memory operand can compute `[base + index*scale + disp]` with scale ∈ {1,2,4,8}. This directly represents many array indexes, but element size alone does not determine loop speed.

```asm
mov  rax, [rdi]                ; *p
mov  rax, [rdi + 8]            ; p->second_member
mov  rax, [rdi + rsi*8]        ; p[i]  for 8-byte elements
lea  rax, [rdi + rsi*8 + 16]   ; &p[i].member — ADDRESS only, no memory access
lea  rax, [rdi + rdi*2]        ; rax = rdi*3  — arithmetic abuse of LEA
mov  eax, [rip + 0x2f31]       ; RIP-relative global access (PIC)
```

**`lea` is the instruction to recognize.** It performs the address computation without touching memory, so compilers use it as a three-operand add/shift that does not clobber flags. An `lea` chain may implement address arithmetic or a constant multiply (Ch. 40 §40.3).

Scales are limited to 1, 2, 4, and 8, but a compiler can use `lea`, shifts, additions, or pointer induction for other strides. Do not infer an expensive multiply from the C++ element size alone.

---

## 41.3 Common Compiler Assembly Idioms — Core

These are representative x86-64 patterns from common compilers. None is a unique source-level decoding: confirm operands, surrounding control flow, target ABI, and compiler output.

| Idiom | Assembly | Meaning |
|---|---|---|
| Zero a register | `xor eax, eax` | `= 0`; commonly dependency-breaking |
| Null/zero test | `test rax, rax; je` | `if (!p)` |
| Sign-extend 32→64 | `movsxd rax, edi` / `cdqe` | `(int64_t)someInt` |
| Zero-extend 8/16→32 | `movzx eax, byte ptr [rdi]` | `(int)someChar` avoiding partial-register stalls |
| Multiply by constant | `lea rax,[rdi+rdi*4]; shl rax,2` | `x * 20` strength-reduced |
| **Divide by constant** | `mov rax, 0x51EB851EB851EB85; mul rsi; shr rdx, 5` | `/ 100` via magic reciprocal — *not* a crypto constant |
| Modulo by power of 2 | `and eax, 63` | `% 64` on unsigned |
| Signed `/2` | `mov eax,edi; shr eax,31; add eax,edi; sar eax,1` | Rounding-toward-zero correction — signed division is more expensive than unsigned |
| Branchless select | `test/cmp ...; cmovge rax, rcx` | ternary or `std::max` compiled branchlessly (Ch. 42 §42.6) |
| Boolean materialize | `setne al; movzx eax, al` | `bool b = (x != y)` |
| Memory clear | `rep stosq` or `vpxor`+`vmovdqu` loops | `memset`/value-init |
| Bulk copy | `rep movsb` (ERMSB) or SIMD loop | `memcpy`/struct copy |
| Possible vtable call | `mov rax,[rdi]; call [rax+16]` | load a table pointer and call an indirect slot under a compatible C++ ABI |
| Bounds-check pair | `cmp rsi, [rdi+8]; jae .throw` | checked container access or an explicit span bounds guard |
| PIC global | `mov rax, [rip+0x1234]` | position-independent data access |
| External call via PLT | `call foo@PLT` | dynamic symbol; lazy mode may resolve it on first call (§41.12) |
| Stack protector | `mov rax, fs:0x28; ... xor rax, fs:0x28; jne __stack_chk_fail` | one Linux/glibc x86-64 `-fstack-protector` pattern |
| TLS access | `mov rax, fs:[0xfffffff8]` or `__tls_get_addr` | `thread_local` (Ch. 24 §24.9) — initial-exec vs general-dynamic model |
| Atomic RMW | `lock xadd [rdi], eax` | one common `fetch_add` mapping (Ch. 25) |
| Ordering instruction | `mfence` or a locked operation | possible mapping; inspect compiler and context |
| Timestamp | `rdtsc` / `rdtscp` / `lfence; rdtsc` | Ch. 43 §43.3 |
| Possible alignment padding | `nopw 0x0(%rax,%rax,1)` | often padding; verify whether control flow executes it |

**Two worth expanding:**

**Division by a constant.** Compilers often replace integer division by a known constant with a multiply-high and shifts. A large constant followed by `mul`/`imul` and a shift is therefore often reciprocal division, but confirm against the source. Runtime divisors may still be simplified through value propagation or specialized versions. Ch. 40 covers the transformation; Ch. 42 covers when the resulting dependency chain matters.

**The `lock` prefix.** Locked instructions are common implementations of atomic RMWs on x86. They request exclusive cache-line ownership and can become expensive under contention (Chs. 25 and 29). A `lock` instruction in a sampled hot loop is evidence to trace back to its source; a reference-count operation is one possible origin (Ch. 9).

---

## 41.4 AArch64 Assembly Fundamentals — Core

AArch64 provides a useful contrast with x86-64. The examples below describe the base ISA and AAPCS64; Apple, Windows, and platform extensions add ABI details.

**Registers:** 31 general-purpose, `x0–x30` (64-bit) / `w0–w30` (32-bit, zero-extending on write, like x86's 32-bit rule). `x31` is context-dependent: `sp` (stack pointer) or `xzr`/`wzr` (the **zero register**, which reads as 0 and discards writes). `x30` = `lr`, the **link register**. 32 vector registers `v0–v31` (128-bit NEON, or SVE's scalable `z0–z31`).

**The architectural contrasts that explain everything:**

| | x86-64 | AArch64 |
|---|---|---|
| Type | CISC, variable length (1–15 bytes) | RISC, fixed 4-byte instructions |
| Memory operands | Most instructions can access memory | **Load/store only** — arithmetic is register-to-register |
| Registers | 16 GP | 31 GP |
| Flags | Many integer ALU operations set flags implicitly | Most integer ALU forms do not; `S`-suffixed and compare/test forms do |
| Return address | Pushed on stack by `call` | Placed in `lr` (`x30`) by `bl`; a simple leaf may avoid saving it |
| Memory ordering | x86-TSO model (Ch. 29 §29.9) | weaker architectural model (Ch. 29 §29.9) |
| Atomics | locked instructions or `cmpxchg` sequences | exclusive pairs or optional atomic extensions selected by target |
| Unaligned access | ISA and memory-type rules apply | ISA, memory-type, and instruction rules apply |
| Zero register | None | `xzr`/`wzr` |

```asm
// int sum(const int* a, size_t n)   — x0 = a, x1 = n
sum:
        mov     w2, wzr            // sum = 0
        cbz     x1, .done          // compare-and-branch-if-zero: no separate cmp
        mov     x3, xzr            // i = 0
.loop:
        ldr     w4, [x0, x3, lsl #2]   // load a[i], scaled index
        add     w2, w2, w4
        add     x3, x3, #1
        cmp     x3, x1
        b.lo    .loop
.done:
        mov     w0, w2
        ret                        // returns to address in lr (x30)
```

**AAPCS64 points:**

- A program with a C++ data race is already undefined on either ISA. For race-free code using weak atomics, a language-permitted outcome may be easier to observe on a weaker hardware mapping. Ch. 25 supplies the language proof.
- **`stp`/`ldp`** (store/load pair) move two registers and are common in prologues/epilogues: `stp x29, x30, [sp, #-16]!` stores the frame pointer and link register while pre-decrementing `sp`.
- **AAPCS64 calling convention:** `x0–x7` carry the first integer/pointer argument slots and `v0–v7` carry FP/SIMD arguments under the ABI's classification rules. Results commonly use `x0` or `v0`; `x19–x29` (with `x29` conventionally the frame pointer), `sp`, and the low 64 bits of `v8–v15` are callee-saved. Register `x18` is platform-specific and should be avoided by portable hand-written assembly. The stack pointer is 16-byte aligned when used for memory access and at public interfaces, and the base procedure-call standard permits no below-`sp` red zone. Platform variants, especially variadic rules, must be checked separately.

---

## 41.5 Calling Conventions and System V AMD64 — Core

A calling convention answers where arguments and results live, which registers survive a call, how the stack is aligned, and how exceptional control flow unwinds. The following details are the **System V AMD64 psABI**, used by ELF systems such as Linux and the BSDs. Darwin's x86-64 convention is closely related but belongs to the Mach-O/Darwin ABI; Windows x64 differs substantially.

### Argument passing

Arguments are classified by type into classes, then assigned to registers in order:

| Class | Registers, in order |
|---|---|
| INTEGER (integers, pointers, `bool`, enums) | `rdi, rsi, rdx, rcx, r8, r9` |
| SSE (`float`, `double`, small vectors) | `xmm0, xmm1, ..., xmm7` |
| MEMORY (anything too large or unsuitable) | Passed in memory according to the ABI; an indirect reference may itself use a register |

The two sequences are **independent counters**: in `void f(int a, double b, int c, double d)`, `a`→`rdi`, `c`→`rsi`, `b`→`xmm0`, `d`→`xmm1`. Mixing does not consume the other class's slots. This trips people up constantly.

Once the six INTEGER registers are exhausted, remaining INTEGER arguments go on the stack — even if SSE registers are free.

```cpp
void f(int a, long b, void* c, char d, int e, int f, int g, double h);
// At callee entry: a→edi ... f→r9d, g→[rsp+8], h→xmm0.
```

### Return values

| Return type | Location |
|---|---|
| Integer/pointer ≤ 64 bits | `rax` |
| Integer or two INTEGER-class eightbytes totaling 65–128 bits (for example, `__int128`) | `rax:rdx` |
| `float`/`double` | `xmm0` |
| Two FP values (e.g. `struct {double,double}`) | `xmm0:xmm1` |
| Many MEMORY-class or non-trivial types | **Hidden pointer**: caller allocates space, passes its address as an *implicit first argument* in `rdi` (shifting all real arguments right by one), and the callee returns that same pointer in `rax` (§41.8) |

### Other rules

- **`this` is passed as the first INTEGER argument** (`rdi`) for non-static member functions, before all declared arguments. With a hidden return pointer, the order is: hidden pointer in `rdi`, `this` in `rsi`.
- **Variadic functions** require `al` to hold an upper bound on the number of
  vector registers used for arguments (0–8); it need not be exact. Calling
  through an incompatible prototype is undefined behavior and can break this
  and other ABI requirements.
- **Direction flag (DF)** must be clear on entry and exit.
- The x87 control word is callee-saved. For `mxcsr`, control bits are preserved while status bits are not. Code that changes floating-point environment state must follow the ABI and language-library contract.

### SysV vs Windows x64

| | SysV AMD64 | Windows x64 |
|---|---|---|
| Integer args | `rdi, rsi, rdx, rcx, r8, r9` (6) | `rcx, rdx, r8, r9` (4) |
| FP args | `xmm0–7` (8) | `xmm0–3` (4) |
| Int/FP slots | Independent counters | **Positional** — a `double` in position 3 uses `xmm2` and *blocks* `r8` |
| Shadow space | None | Caller reserves **32 bytes** for the callee to spill the 4 register args |
| Red zone | **128 bytes** | None |
| Callee-saved | `rbx, rbp, r12–r15` | `rbx, rbp, rdi, rsi, r12–r15, xmm6–15` |
| Aggregate return | In registers if its eightbytes classify suitably; otherwise indirect | Qualifying small aggregates may use integer registers; larger, non-qualifying, and non-trivial cases are commonly indirect, with separate vector rules |

These are interoperability rules, not a portable ranking of performance. Optimizers can inline calls, allocate values differently within a function, and specialize internal conventions when no external boundary remains.

---

## 41.6 Stack Alignment and the Red Zone — Core

### The 16-byte alignment rule

Under SysV AMD64, `rsp` is 16-byte aligned at a normal call site. Because `call` pushes an 8-byte return address, a normally entered callee begins with `rsp ≡ 8 (mod 16)`.

```
                 rsp % 16 == 0     ← required before `call`
call pushes RIP: rsp % 16 == 8     ← state at callee entry
push rbp:        rsp % 16 == 0     ← standard prologue restores alignment
```

The rule lets a callee establish aligned local storage predictably. Some aligned-move instructions require aligned addresses and can fault when used on misaligned memory; the observed OS signal is platform-specific (Ch. 3 §3.3).

It breaks most often in hand-written assembly, JIT code, foreign-function interfaces, or mismatched conventions. A fault on an aligned stack move inside a callee is evidence to inspect the caller's stack alignment; it is not proof, because memory corruption and invalid pointers remain common causes.

`-mpreferred-stack-boundary=N` and `-mstackrealign` are target-specific controls for stack alignment and interoperation. A used over-aligned local may require dynamic realignment (for example, an `and rsp, -32` sequence) and extra frame bookkeeping; inspect the generated code rather than assuming one prologue.

### The red zone

The **red zone** is the **128 bytes below `rsp`** that a function may use as scratch space **without adjusting `rsp`**, guaranteed not to be clobbered by signal handlers or interrupts.

```
      higher addresses
      ┌──────────────────┐
      │ caller's frame   │
 rsp →├──────────────────┤
      │  RED ZONE        │  128 bytes — usable, no rsp adjustment needed
      │  (leaf scratch)  │
      ├──────────────────┤
      │  unsafe          │
      lower addresses
```

It allows a leaf function to use limited scratch storage without changing `rsp`. Whether a compiler does so depends on flags, instrumentation, and its frame layout.

```asm
; leaf using the red zone — note the absence of any rsp adjustment
f:      mov     QWORD PTR [rsp-8], rdi
        mov     QWORD PTR [rsp-16], rsi
        ...
        ret
```

**Where the red zone does not exist or must be disabled:**

- **Kernel code.** Interrupts may use the current stack and clobber space below `rsp`; x86-64 Linux kernel code is built without the user-space red-zone convention.
- **Signal handlers** in user space are safe, because the kernel's signal delivery explicitly skips 128 bytes below `rsp` when building the signal frame. That skip *is* the red zone guarantee.
- **Windows x64** has no red zone.
- **Interrupt/exception handlers and similarly privileged code** must follow their platform's stack rules and are commonly built with `-mno-red-zone`; do not infer safety from a source attribute alone.

A related trap: **inline assembly that writes below `rsp`** without coordinating with the compiler's frame model can corrupt red-zone scratch data, producing failures that appear only in optimized builds where the compiler chose to use that space.

---

## 41.7 Caller-Saved and Callee-Saved Registers — Core

The register-preservation contract, which determines what a function may assume survives a call.

| Class | Registers | Rule |
|---|---|---|
| **Callee-saved** (non-volatile) | `rbx, rbp, r12, r13, r14, r15` | The callee must restore them before returning. The caller may hold live values across a call. |
| **Caller-saved** (volatile / scratch) | `rax, rcx, rdx, rsi, rdi, r8–r11`, **all `xmm`/`ymm`/`zmm`** | The callee may destroy them. The caller must spill anything it needs across a call. |
| Special | `rsp` (restored by convention), `rbp` (callee-saved, frame pointer if used) | |

Under SysV AMD64, vector registers are caller-saved. A call can therefore cause live vector values to be spilled, but the allocator may also rematerialize values, shorten live ranges, or use other registers. Windows x64 preserves part of the vector-register set, subject to its exact ABI rules.

**Consequences for code generation:**

- A leaf function with modest register pressure may need no save/restore sequence.
- A function with values live across a call may keep some in callee-saved registers and save those registers in its prologue. Other values can spill, be recomputed, or have shorter live ranges.
- **Register pressure** is why aggressive inlining can backfire (Ch. 40 §40.4): combining more live values into one body can exhaust the allocatable registers and force spills.

```asm
; a function that keeps two values across a call
f:      push    rbx
        push    r12
        sub     rsp, 8            ; realign to 16 (2 pushes = 16, +8 from call = 8; needs 8 more)
        mov     rbx, rdi
        mov     r12, rsi
        call    g                 ; rbx and r12 survive; rax/rcx/rdx/rsi/rdi/r8-r11 do not
        add     rax, rbx
        add     rsp, 8
        pop     r12
        pop     rbx
        ret
```

Note the `sub rsp, 8` for alignment — reading a prologue's push count plus the `sub` and checking it sums to a multiple of 16 is a good sanity check when debugging alignment faults (§41.6).

**Inline assembly must declare clobbers correctly**, or the compiler will assume its values survived:

```cpp
asm volatile("rdtsc" : "=a"(lo), "=d"(hi));  // declares rax, rdx written
unsigned eax = 0, ebx, ecx, edx;
asm volatile("cpuid"
             : "+a"(eax), "=b"(ebx), "=c"(ecx), "=d"(edx));
asm volatile("" ::: "memory");                          // compiler barrier only (Ch. 25 §25.16)
```
Omitting a clobber can produce optimization-dependent miscompilation: the compiler may keep a live value in a register that the assembly silently destroys.

---

## 41.8 Aggregate Parameters, Returns, and Tail Calls — Core

Aggregate rules are ABI rules, not consequences of `sizeof` alone. The summary below targets the current SysV AMD64 psABI; verify examples with the named compiler and target whenever an interface depends on them.

### The SysV classification algorithm

1. The ABI recursively classifies an aggregate into one or more eightbytes.
2. Objects larger than the register-class limit, objects with unaligned fields, and certain non-trivial C++ types use memory/indirect conventions.
3. Simplified common cases classify integer/pointer content as INTEGER and floating/vector content as SSE.
4. If the required register classes are unavailable, the argument is passed in memory. Exact cleanup, homogeneous-vector, `long double`, and platform-extension rules require the psABI.

```cpp
struct A { int x, y; };                  // 8 B, INTEGER      → one register (rdi)
struct B { double x, y; };               // 16 B, SSE,SSE     → xmm0, xmm1
struct C { long x; double y; };          // 16 B, INTEGER,SSE → rdi, xmm0
struct D { long a, b, c; };              // LP64: 24 B         → MEMORY
struct E { long x; ~E(); };              // non-trivial ABI handling
struct F { std::unique_ptr<int> p; };    // non-trivial ABI handling
```

A small non-trivial wrapper can use an **invisible reference**: the caller materializes the object and passes its address. That address may occupy an argument register; “class MEMORY” does not mean the object bytes are always pushed onto the stack. A `unique_ptr<T>` can therefore have the same stored size as `T*` while differing at a non-inlined ABI boundary. This is an observation about a named ABI, not a general claim that RAII has runtime overhead. Inlining and whole-program optimization can erase the boundary (Ch. 40 §40.3).

### Return values

- Suitable small, trivial aggregates are returned in `rax:rdx` and/or `xmm0:xmm1` according to classification.
- Otherwise ⇒ **hidden return pointer (sret)**: the caller allocates the storage, passes its address as an implicit first argument in `rdi`, and the callee returns that pointer in `rax`.

```asm
; Big make_big();   →  Big* make_big(Big* hidden_ret)
call    make_big     ; rdi = &result_storage in the caller's frame
```

The hidden destination is how many implementations realize direct construction into caller-provided storage. The C++ guarantee comes from the language's prvalue/copy-elision rules (Ch. 10 §10.1); the hidden pointer is one ABI implementation technique. NRVO remains optional where the standard does not mandate elision.

### ABI-visible design rules

- If call-boundary traffic matters, inspect how the actual target passes the type before redesigning it.
- Size, alignment, triviality, field classes, and register availability can all affect an aggregate.
- Beware mixed classes: `struct { float a; int b; }` is 8 bytes but classifies as INTEGER (an eightbyte with any integer member is INTEGER), so it travels in a GP register and needs moves to get into an FP register.
- **Bit-fields, `[[no_unique_address]]`, and empty bases** all participate in classification and have caused real cross-compiler ABI bugs. GCC and Clang have shipped mutually incompatible `[[no_unique_address]]` and empty-struct-in-C classifications; `-Wpsabi` warns about the ones GCC knows it changed.

---

### Tail calls

A **tail call** is a call in tail position — its result is immediately returned, with no work after it. The compiler can replace `call f; ret` with `jmp f`, reusing the current stack frame.

```cpp
int g(int x);
int f(int x) { return g(x + 1); }     // tail call
```
```asm
f:      add     edi, 1
        jmp     g                     ; frame reused; g's `ret` returns to f's caller
```

**Benefits:**

- Reuses the current frame, so an implementation that performs tail-recursion elimination can avoid linear stack growth.
- Can reduce call/return stack traffic; instruction-fetch and prediction effects remain workload- and microarchitecture-dependent.
- Enables **continuation-passing dispatch** patterns in which handlers jump to the next state without accumulating frames. This changes return-stack and branch-prediction behavior, so it must be measured on the target.

**What can defeat tail-call optimization:**

| Blocker | Why |
|---|---|
| A local whose address escapes into the callee | The frame cannot be destroyed before the callee runs |
| A non-trivially-destructible local still alive across the call | Its destructor must run *after* the call returns, so the call isn't in tail position |
| A `try`/`catch` or any active cleanup scope | Unwinding state must survive |
| The callee returns a different type / needs a hidden sret pointer mismatch | Frame layouts incompatible |
| Outgoing arguments or hidden ABI state cannot be made compatible | The current argument area or calling sequence cannot be safely reused |
| Low-optimization/debug-oriented builds | Transformation is commonly absent |
| Sanitizers, `-fno-optimize-sibling-calls` | Explicitly disabled to preserve stack traces |

The **destructor blocker is the C++-specific one and the most commonly missed**:

```cpp
int f(int x) { std::string s = make(); return g(x); }   // NOT a tail call: ~s runs after g
int f(int x) { { std::string s = make(); use(s); } return g(x); }  // eligible: scope closed first
```

Compiler flags and extensions control sibling calls. Clang's `[[clang::musttail]]` extension requires a tail call or diagnoses the statement; support and restrictions are compiler-version facts, not C++23 guarantees.

**Diagnostic cost:** a tail-called intermediate function has no physical frame, so a debugger or profiler may show the callee reached from an earlier caller (Ch. 58 §58.5). Debug- or profiling-oriented builds sometimes disable sibling-call optimization for clearer stacks. Prediction effects are microarchitecture- and call-sequence-dependent (Ch. 27 §27.6).

---

## 41.9 Stack Unwinding at the Call Boundary — Core

Unwinding reconstructs caller state from the current program counter and registers. Two common sources are:

- a compiler-maintained frame-pointer chain, when the build preserves one and every traversed frame obeys it;
- unwind metadata such as DWARF CFI, which describes how to recover the caller at each instruction range.

Neither mechanism recreates a frame removed by inlining or a tail call. Hand-written assembly needs correct unwind directives if exceptions or profilers may cross it. A production crash record should preserve raw addresses, module load addresses, and build IDs so symbolization can occur against the exact binaries. §41.16 covers the tradeoffs in depth.

```
current PC/registers
        │ frame pointer or CFI rule
        ▼
caller's CFA ──► saved return address ──► caller PC
        │
        └──── repeat until the root or an invalid frame
```

This completes the call-boundary path: arguments and returns (§41.5), stack and preservation (§§41.6–41.7), aggregates and tail calls (§41.8), then unwinding. The next sections follow code from relocatable object to loaded image.

---

## 41.10 ELF Sections and Segments — Role-specific

**ELF** (Executable and Linkable Format) is used by Linux and many Unix-like systems. Mach-O and PE/COFF are different containers. The essential distinction is: **sections organize linking and analysis; program segments describe runtime mapping.** Some bytes appear in both views, and a stripped executable can run without a section-header table.

```
ELF header
  ├─ Program headers (segments)  → used at RUNTIME by the kernel/ld.so
  │    LOAD  R-X  ← .init .text .fini .plt        (code)
  │    LOAD  R--  ← .rodata .eh_frame_hdr .eh_frame (constants)
  │    LOAD  RW-  ← .init_array .data.rel.ro .data .bss
  │    DYNAMIC    ← .dynamic
  │    GNU_RELRO  ← region remapped read-only after relocation
  │    TLS        ← .tdata .tbss
  ├─ Sections                    → used at LINK time
  └─ Section headers (strippable; segments are not)
```

**The sections to know:**

| Section | Purpose |
|---|---|
| `.text` | Executable code |
| `.rodata` | Read-only constants, string literals, jump tables |
| `.data` | Initialized writable globals — occupies file space |
| `.bss` | Zero-initialized storage represented as `SHT_NOBITS`; it contributes memory size but normally no payload bytes in the file |
| `.rodata.cst*`, `.rodata.str1.*` | Mergeable constant/string pools (dedup via `SHF_MERGE`) |
| `.init_array` / `.fini_array` | Initialization/finalization callbacks; constructors normally run before `main`, while finalizers run during normal process termination (Ch. 5 §5.9) |
| `.plt`, `.got`, `.got.plt` | Dynamic-linking indirection (§41.12) |
| `.dynamic`, `.dynsym`, `.dynstr` | Dynamic linking metadata and the exported/imported symbol table |
| `.symtab`, `.strtab` | Full static symbol and string tables; commonly removed by a full strip and not required to load the image |
| `.rela.dyn`, `.rela.plt` | Relocations applied at load time |
| `.eh_frame`, `.eh_frame_hdr` | Runtime unwind tables (§41.16); stripping policies normally preserve required allocated unwind data |
| `.gcc_except_table` | Landing-pad and action tables for `catch` clauses |
| `.tdata`, `.tbss` | TLS initialization images |
| `.debug_*` | DWARF debug info (§41.15) |
| `.note.gnu.build-id` | The build ID used to match binaries to symbol files |
| `.comment` | Compiler version strings |

`GNU_RELRO` marks a region the ELF loader can make read-only after relocation, hardening writable control data. “Full RELRO” commonly combines `-z relro` and eager binding (`-z now`) so relevant PLT/GOT entries can also become read-only. It moves binding work toward startup and avoids lazy first-call resolution; exact defaults and layout vary by linker and distribution (§41.13).

**Practical numbers:** `size -A ./app` gives per-section sizes; `readelf -lW ./app` shows segments and their section mapping; `readelf -SW ./app` shows sections with flags (`A`=alloc, `X`=exec, `W`=write, `M`=merge).

---

## 41.11 ELF Symbols, Relocations, and a Link Diagnosis — Role-specific

### Symbols

A **symbol** binds a name to an address (or a request for one). Each has a **binding**, a **type**, a **visibility**, and a **section index**.

| Binding | Meaning |
|---|---|
| `GLOBAL` | Externally bound; multiple strong definitions in one static link are generally an error, while dynamic lookup has additional scope/preemption rules |
| `LOCAL` | Internal to the object (`static`, anonymous namespace) |
| `WEAK` | Global, but may be overridden; unresolved weak references become 0 rather than an error (Ch. 1 §1.14) |

| Type | Meaning |
|---|---|
| `FUNC`, `OBJECT` | Code, data |
| `NOTYPE` | No more specific symbol type is recorded; undefinedness is instead represented by section index `SHN_UNDEF` |
| `TLS` | Thread-local |
| `GNU_IFUNC` | Resolved by running a resolver function at load time; commonly used for target-dependent dispatch |

| Visibility | Meaning |
|---|---|
| `DEFAULT` | Eligible for external visibility/preemption when present in the dynamic symbol table; actual export and interposition depend on link/loader policy |
| `HIDDEN` | Not exported; internal to the library. `-fvisibility=hidden` makes this the default. |
| `PROTECTED` | Exported but not interposable |

Hidden visibility prevents external preemption of a definition and reduces accidental ABI exposure. It can shrink dynamic metadata and permit more direct references; inlining still depends on whether the compiler or linker can see the body (Ch. 40 §40.3).

**Weak/COMDAT symbols in practice:** ELF compilers may use weak definitions,
COMDAT groups, or both for inline functions and template instantiations so a
linker can retain one equivalent copy. This is a common Itanium-C++-ABI
implementation of ODR entities, not a C++ requirement. Explicit weak references
are another ELF extension (Ch. 1 §§1.9 and 1.14).

### Relocations

A **relocation** is an instruction to the linker or loader: "patch the value at offset X using symbol S and formula R". The important x86-64 types:

| Type | Meaning |
|---|---|
| `R_X86_64_PC32` | 32-bit PC-relative — normal intra-module calls and RIP-relative data |
| `R_X86_64_PLT32` | Call routed through the PLT |
| `R_X86_64_GOTPCREL` | Load the address from the GOT, RIP-relative |
| `R_X86_64_64` | Absolute 64-bit address; whether the static linker or dynamic loader applies it depends on the output artifact |
| `R_X86_64_GLOB_DAT` | Fill a GOT entry with a symbol's address |
| `R_X86_64_JUMP_SLOT` | Fill a PLT's GOT entry (lazily, or eagerly with BIND_NOW) |
| `R_X86_64_RELATIVE` | Add the load base — the cheap, symbol-less relocation for internal pointers in PIE |
| `R_X86_64_COPY` | Copy a data object from a library into the executable (legacy, ABI-fragile) |
| `R_X86_64_TPOFF64`, `R_X86_64_TLSGD` | TLS offsets/models |

The number and kind of dynamic relocations are inputs to startup cost, alongside symbol lookup, constructors, page faults, and loader policy. Some ELF toolchains support compact relative-relocation encodings such as RELR; availability depends on linker, loader, target, and the deployment's loader baseline (Ch. 60).

```bash
readelf -rW ./app | head          # relocations
readelf -rW ./app | grep -c RELATIVE
nm -C --defined-only ./app        # defined symbols, demangled
nm -CD ./libfoo.so                # dynamic symbol table only
```

### Worked diagnosis: declaration, symbol, relocation, link

```cpp
// api.hpp
int price(int);

// main.cpp
#include "api.hpp"
int main() { return price(7); }
```

```bash
c++ -std=c++23 -c main.cpp -o main.o
nm -C main.o
readelf -rW main.o
c++ main.o -o app
```

`nm -C` shows `U price(int)`: the object requests a definition. `readelf -rW` shows a relocation at the call site naming the mangled symbol. The final link reports an undefined reference because no input defines it. This is a link-time failure, not a runtime loader failure.

```
undefined symbol
  ├─ expected C++ name → missing object/library, wrong signature, or archive order
  ├─ expected C name but got mangled C++ → mismatched `extern "C"` (Ch. 1)
  ├─ definition exists but is local/hidden → visibility mistake
  └─ non-PIC relocation in a shared object → rebuild or change the target/code model
```

Use `nm -C`, `readelf -Ws`, and link-map or trace options rather than guessing from the source declaration. An error naming `R_X86_64_32` or `R_X86_64_32S` while building a PIE/shared object often indicates a non-PIC input, but the exact remedy depends on relocation, code model, and target.

---

## 41.12 PLT, GOT, and Position-Independent Code — Role-specific

**Position-independent code** can execute at any load address, which is required for shared libraries and for **ASLR** on executables (PIE). PC-relative addressing and, where necessary, linkage tables avoid fixed absolute addresses.

- **GOT (Global Offset Table)** — linker-created address slots. Some are fixed by static linking; others receive load-time relocations or dynamic resolutions. Code can load an address from a GOT slot instead of embedding it.
- **PLT (Procedure Linkage Table)** — linker-created call stubs that may route imported calls through GOT slots. Linker relaxation, `-fno-plt`, eager binding, and platform hardening can change or remove this path.

### Data access

```asm
; fixed absolute address:
mov  eax, [0x601040]          ; unsuitable as-is for freely relocated PIE/shared code
; PIC, module-internal (hidden visibility or static):
mov  eax, [rip + 0x2f31]      ; direct RIP-relative reference after linking
; PIC, possibly-interposed global:
mov  rax, [rip + got_offset]  ; load address from GOT (one extra load)
mov  eax, [rax]               ; then dereference
```

RIP-relative addressing makes many internal x86-64 PIC references direct. That does not make PIE universally free: symbol preemption, code model, register pressure, linker relaxation, and target all affect the result.

### Function calls and lazy binding

The following is the classic x86-64 ELF lazy-PLT shape used for explanation; exact stub instructions and resolver protocol are linker-, loader-, and hardening-specific.

```
call foo@PLT
  ↓
PLT[n]:  jmp  [GOT[n]]          ; first call: GOT[n] points back to PLT[n]+6
         push index             ; push the relocation index
         jmp  PLT[0]            ; → _dl_runtime_resolve
                                ;   resolves foo, WRITES its address into GOT[n]
  ↓ subsequent calls
PLT[n]:  jmp  [GOT[n]]          ; now jumps straight to foo
```

With lazy binding, the first call performs loader resolution and later calls use the resolved GOT entry. The latency depends on loaded objects, lookup scope, cache state, hardening, and loader version; measure it rather than assigning a universal cycle count.

When first-call latency is undesirable, available choices include:

1. **`-Wl,-z,now`** (BIND_NOW) — request eager dynamic binding; combined with `-Wl,-z,relro` this commonly provides full RELRO for eligible GOT data. Loaders such as glibc's also support `LD_BIND_NOW=1`.
2. **Static linking where the deployment and libc/plugin requirements permit it** — removes ordinary dynamic symbol binding but has compatibility tradeoffs.
3. **Visibility and semantic-interposition controls** such as
   `-fvisibility=hidden` and, where appropriate,
   `-fno-semantic-interposition`—these can enable direct internal references and
   optimization, subject to actual visibility and link decisions (Ch. 40).
4. **Startup warm-up** so expected lazy work occurs before the measured service phase (Ch. 60 §60.5).

**`-fPIC` vs `-fPIE`:** on GCC/Clang ELF targets, `-fPIC` prepares code for shared objects and `-fPIE` for position-independent executables. Their optimization assumptions and supported code models are toolchain-specific. Disabling PIE loses an ASLR defense and should be a security/deployment decision, not a folklore performance tweak.

**Verification:** `objdump -d --section=.plt`, `readelf -r` for `JUMP_SLOT` entries, glibc's `LD_DEBUG=bindings ./app` to trace dynamic-loader bindings, and `checksec --file=./app` for a quick RELRO/PIE/BIND_NOW summary.

---

## 41.13 Dynamic Linking and Loading — Role-specific

On a typical glibc x86-64 ELF system, the interpreter named by `PT_INTERP` loads dependencies, applies dynamic relocations, and participates in initialization before `main`. Its pathname and behavior vary across OSes, architectures, libcs, and container formats.

**The startup sequence:**

1. Kernel maps the executable's `PT_LOAD` segments and the interpreter, then jumps to the interpreter.
2. The loader follows `DT_NEEDED` entries and its platform-specific search rules. `RPATH`, `RUNPATH`, environment variables, caches, secure-execution mode, and transitive dependencies interact in ways that must be checked in the loader documentation.
3. Relocations are applied per object; loaders commonly process inexpensive relative relocations before symbol-based work, but batching and ordering are implementation details.
4. RELRO regions are `mprotect`ed read-only.
5. TLS blocks are set up; initialization callbacks run in the loader's
   object/initialization order. Dependencies constrain that order, but cycles,
   preload/audit objects, and loader policy make “dependency order” alone too
   simple.
6. Control passes to `_start` → `__libc_start_main` → `main`.

**Symbol resolution and interposition.** ELF lookup scopes and preemption rules depend on load groups, visibility, flags such as `RTLD_LOCAL`/`RTLD_DEEPBIND`, namespaces, symbol versions, and loader implementation. `LD_PRELOAD` commonly injects definitions early enough to interpose default-visible symbols, but “first definition globally wins” is too crude for diagnosis. Use loader traces.

**Versioning.** glibc uses symbol versioning (`memcpy@GLIBC_2.14`) so that an ABI change can coexist with the old behavior. Two consequences:

- A binary requiring a symbol version absent on the deployment system fails to load—the classic `version 'GLIBC_x.y' not found`. Build against a deliberate deployment baseline or sysroot; do not assume every newer/older combination is compatible.
- Your own libraries can use a version script (`-Wl,--version-script=`) to control exports precisely as part of an ABI policy (Ch. 44 §44.8).

**`dlopen`/`dlsym`** for runtime loading: a possible plugin constrains
whole-program devirtualization because new implementations can appear at
runtime. Entry points reached only by string lookup also need an explicit
export/retention contract so compilation or section GC does not remove them
(Ch. 40 §§40.4 and 40.9).

**Static vs dynamic:**

| | Static | Dynamic |
|---|---|---|
| Startup | Avoids ordinary dynamic binding; constructors and paging still matter | Loader work depends on dependency graph and relocation policy |
| Call boundary | Can enable direct calls and whole-program work | May be direct, PLT-mediated, or relaxed by the linker |
| Deployment | Fewer runtime library files; not automatically self-contained or reproducible | Version/search-path skew risk across hosts |
| Memory | File-backed executable pages can be shared by processes running that artifact | Shared-library pages can be shared across different executables |
| Updates | Relink and redeploy | Update a `.so` only under compatible ABI and process load/restart policy |
| Caveats | glibc NSS, locale, plugin, and resolver interactions require target-specific qualification | loader/search/interposition behavior requires qualification |

Choose from deployment, update, security, licensing, plugin/NSS, memory-sharing, and latency requirements. A minimal dynamic set with eager binding is often a useful compromise; static linking is not automatically self-contained on every libc.

**Diagnostics:** `ldd ./app` can invoke a target interpreter or, in some
implementations/circumstances, execute the program; never use it on an untrusted
file. Prefer `readelf -d`/`objdump -p` for static inspection.
`LD_DEBUG=libs,bindings,statistics` is a glibc-loader diagnostic. Library-call
tracing belongs with Chapter 34 §34.10.

---

## 41.14 Binary Inspection Tools — Role-specific Reference

Know what each tool *reveals*; the tool choice is usually the first half of a good answer.

| Tool | Reveals | Canonical invocation |
|---|---|---|
| **`objdump`** | Disassembly, section contents, relocations, headers | `objdump -d -C -M intel --no-show-raw-insn ./app`<br>`objdump -dS ./app` (source-interleaved, needs `-g`)<br>`objdump -R ./app` (dynamic relocations) |
| **`readelf`** | Everything ELF, without disassembling | `readelf -hSlWd ./app` (header, sections, segments, dynamic)<br>`readelf -rW`, `readelf -n` (notes/build-id) |
| **`nm`** | Symbol table with type letters | `nm -C --defined-only --size-sort -S ./app`<br>`nm -CDu ./lib.so` (undefined dynamic symbols) |
| **`c++filt`** | Demangles Itanium C++ names | `c++filt _ZNSt6vectorIiSaIiEE9push_backEOi` |
| **`strings`** | Embedded literals; quick version/config discovery | `strings -n 8 ./app` |
| **`size`** | Per-section sizes — the metric for `-O3`/ICF/`--gc-sections` effects | `size -A ./app` |
| **`ldd`** | Shared-library dependency resolution for trusted binaries | `ldd ./app` |
| **`strip`** / `objcopy` | Remove/split debug info | `objcopy --only-keep-debug app app.dbg; strip -g app; objcopy --add-gnu-debuglink=app.dbg app` |
| **`addr2line`** | Address → file:line, including inline frames | `addr2line -Cfie ./app 0x4011a6` |
| **`perf`** | Where time goes, at instruction granularity | `perf record -g ./app; perf annotate` |
| **`llvm-mca`** | Static throughput/port-pressure model of a code block | `llvm-mca -mcpu=skylake asm.s` |
| **`pahole`** | Struct layout, holes, cacheline crossings (Ch. 3 §3.4) | `pahole -C Order ./app` |
| **`bloaty`** | Attributes binary size to symbols/sections/compile units | `bloaty -d compileunits ./app` |
| **`checksec`** | RELRO, PIE, NX, stack canary, BIND_NOW status | `checksec --file=./app` |
| **`gdb`** | Live disassembly and register state | `disassemble /s`, `info registers`, `x/16i $pc` |

`nm` letters commonly include `T/t` for text, `D/d` for initialized data, `B/b` for BSS, `R/r` for read-only data, `U` for undefined, and `W/w` for weak. Exact letters and options vary between GNU and LLVM tools.

**Common workflows:**

```bash
# Did this function get inlined away?
nm -C ./app | grep -c 'parse_message'

# Which vector-looking mnemonics appear? (not a deployment-baseline proof)
objdump -d ./app | grep -oE '\bv[a-z0-9]+\b' | sort -u | head

# Why is the binary 400 MB?
bloaty -d compileunits,symbols ./app | head -30

# Which library is a symbol coming from?
LD_DEBUG=bindings ./app 2>&1 | grep 'binding file.*malloc'

# What does this hot loop actually cost?
perf record -e cycles:pp ./app && perf annotate --stdio parse_message
```

---

## 41.15 Debug Information and Symbolization — Core

**Symbolization** is turning an address into `function (file:line)`. Tools can obtain names from symbol tables and/or debug information; DWARF supplies source lines, inline stacks, types, and variable-location descriptions on the ELF platforms discussed here.

**Representative GCC/Clang debug options** (availability and exact contents vary by compiler and version):

| Flag | Contents |
|---|---|
| `-g0` | None |
| `-g1` (GCC) / `-gline-tables-only` (Clang; historically `-gmlt`) | Reduced debug information oriented toward line-level symbolization |
| `-g` (`-g2`) | Full: types, variables, locations, inline stacks |
| `-g3` | Plus macro definitions |
| `-gsplit-dwarf` | Emit `.dwo` files separately; the binary keeps only a skeleton (§ below) |
| `-gz` | Compress `.debug_*` sections |

Ordinary `.debug_*` sections are non-`SHF_ALLOC`, so the loader does not map them as runtime segments. Debug information still costs storage, link/tool time, distribution bandwidth, and possibly build confidentiality. A common release practice is optimized code plus separate debug data retained by build ID.

**Split DWARF** can reduce linked-binary size and debug-data work: `-gsplit-dwarf` puts much of the debug data in per-object `.dwo` files, while the main object keeps a skeleton. Supported toolchains can build an index with linker or debugger utilities; `dwp` can package split data. The exact index and packaging workflow is toolchain-specific.

**The separate-debug-file workflow** (what distributions and serious shops do):

```bash
g++ -O2 -g ... -o app
objcopy --only-keep-debug app app.debug
strip --strip-debug app
objcopy --add-gnu-debuglink=app.debug app
```
Now `app` is smaller, and gdb can find `app.debug` via the debuglink or a **build ID** (`readelf -n app` → `.note.gnu.build-id`). Symbol servers commonly index by build ID so a crash address can be matched to the corresponding debug file (Ch. 58 §58.3). A build ID is an identifier, not an authenticity guarantee. **Store debug files for every deployed build, keyed by build ID** — the single most valuable operational practice in this section.

**Symbolizing optimized code — the hard parts:**

- **Inlining destroys the naive mapping.** One address belongs to several source locations (the inline stack). `addr2line -i` (or `-Cfie`) and `llvm-symbolizer` can print the inline stack. A report that omits inline frames can be misleading; use the relevant inline-reporting option in the profiler or symbolizer.
- **Variables are "optimized out"** because their locations are register-based and change per-instruction. DWARF location lists express this, but gdb will still report values as unavailable in ranges where they are dead.
- **Line attribution is approximate** — instructions are scheduled across statement boundaries, so a breakpoint may land somewhere surprising. A debug-oriented optimization level changes the artifact and may improve source-level stepping, but production behavior must be checked on the production build (Ch. 40).
- **Tail calls remove frames entirely** (§41.8).
- **BOLT and post-link tools** rewrite addresses; supported debug and unwind metadata must be preserved or updated (Ch. 40 §40.8). Validate symbolization and unwinding on the final shipped artifact, not on the pre-rewrite one.

**Runtime symbolization inside your own process** (crash handlers, flight recorders): facilities such as glibc `backtrace()`/`backtrace_symbols()`, `libunwind`, and C++23 `std::stacktrace` differ in symbol coverage, allocation, locking, and signal-safety properties. A robust crash-handler pattern is to record **raw addresses, module load addresses, and build IDs** and symbolize offline; do not assume general-purpose unwinding or formatting is async-signal-safe (Ch. 33 §33.8, Ch. 58 §58.12).

---

## 41.16 Deep Dive: Stack Unwinding and Frame Pointers — Deep dive

**Unwinding** reconstructs caller state while walking active stack frames. It is needed for exception propagation, backtraces, and many profiler call graphs. Common mechanisms include frame chains and unwind metadata; hardware branch records can instead help reconstruct a bounded call history.

### Frame pointers

On x86-64, an eligible function compiled with frame-pointer retention commonly establishes a frame with a sequence such as `push rbp; mov rbp, rsp`, creating a linked list:

```
   rbp ──► [saved rbp] ──► [saved rbp] ──► ...
           [return addr]   [return addr]
```
When the chain is intact, walking it is simple and does not require per-PC unwind bytecode. A production unwinder still needs bounds checks and fault-safe memory access; “has frame pointers” does not make arbitrary symbolization async-signal-safe.

Exact prologues vary with ISA, compiler, optimization, leaf-function policy, instrumentation, and attributes. A build flag is not by itself proof that every instruction address in every object participates in one uniform chain; inspect the shipped binary and validate representative stacks.

**Cost:** preserving a frame pointer can add prologue/epilogue work and removes one allocatable register on targets that dedicate it. The workload effect ranges from negligible to material and changes with ISA, compiler, leaf-function policy, and register pressure. Measure the actual build; distribution defaults are versioned policy choices.

### DWARF CFI (`.eh_frame`)

On ELF/DWARF platforms, compilers commonly emit **Call Frame Information**: rules over instruction-address ranges that describe how to compute the caller's stack state and recover saved registers. This can work with the frame pointer omitted and is used by common C++ exception and unwinding implementations. Other object formats and platforms use different unwind metadata.

Metadata unwinding typically looks up an FDE and interprets CFI rules for each frame. It is usually more work than following an intact frame chain, and library implementations may have locking, allocation, caching, or signal-safety constraints. Check the unwinder actually deployed.

| | Frame pointers | DWARF CFI | ORC (kernel) | LBR |
|---|---|---|---|---|
| Runtime cost | build/workload-dependent | metadata size; work when unwinding | platform-specific | hardware/OS-dependent |
| Unwind work | simple chain walk when intact | FDE lookup plus rule evaluation | kernel implementation-specific | capture mechanism-specific |
| Depth limit | bounded by valid frames | bounded by metadata/stack | bounded by valid frames | hardware-generation-dependent |
| Signal-handler use | raw walking may be feasible with care | depends on unwinder implementation | N/A | capture interface-dependent |
| Optimized-code coverage | only where the chain is preserved | where metadata is complete | within supported kernel code | within capture and reconstruction limits |
| `perf` flag | `--call-graph fp` | `--call-graph dwarf` | — | `--call-graph lbr` |

`perf --call-graph dwarf` can copy stack data with samples for later unwinding; capture size and overhead depend on options and perf version. LBR-based call graphs have hardware depth and availability limits. Choose among frame-pointer, DWARF, and hardware-assisted capture by measuring overhead and validating stack completeness.

**Exception-handling implications** (Ch. 10 §10.5): table-based “zero-cost” implementations are designed to avoid per-`try` dynamic bookkeeping on the ordinary path, but code layout and metadata size can still change. Throwing performs search and cleanup work whose cost depends on depth, types, runtime, and loaded objects. Measure before making a build-wide exception-policy decision.

**Diagnostic signature:** truncated `--call-graph fp` stacks suggest omitted or broken frame chains. High capture overhead with DWARF motivates checking sample rate and stack-dump size. Missing intermediate logical frames can also be caused by inlining or tail calls.

---

## 41.17 Code Layout and Cold Splitting — Skippable Reference

Instruction fetch uses caches, translation structures, and predictors. Linkers and post-link tools may rearrange code while preserving control-flow and metadata contracts, but layout is not “free”: branch ranges, alignment, unwind data, debug information, and profile quality constrain it (Ch. 27 §§27.2 and 27.6).

Code layout affects instruction-cache, iTLB, branch-prediction, and fetch behavior, but the relevant capacities and counters are microarchitecture-specific. Profile-guided block placement, hot/cold splitting, and post-link reordering can improve locality without changing source semantics. Ch. 40 covers the compiler and BOLT transformations; Chs. 42–43 cover CPU effects and measurement.

**The manual C++ pattern**, which you should be able to write from memory:

```cpp
// GNU attributes request an out-of-line cold slow path.
[[gnu::noinline, gnu::cold]]
void handle_sequence_gap(Session&, Seq expected, Seq got);

inline void on_message(Session& s, const Msg& m) {
    if (m.seq != s.expected) [[unlikely]] {         // layout hint
        handle_sequence_gap(s, s.expected, m.seq);
        return;
    }
    apply(s, m);            // intended common path
    ++s.expected;
}
```

These GNU attributes and the standard `[[unlikely]]` hint influence, but do not mandate, placement. `noexcept` is a semantic promise and must not be added merely as a layout hint. Confirm section placement and samples in the final linked binary.

**Measuring whether layout is your problem:**

For example, on a supported Intel Linux PMU:

```bash
perf stat -e cycles,instructions,L1-icache-load-misses,iTLB-load-misses,\
idq.dsb_uops,idq.mite_uops ./app
perf stat --topdown ./app        # is 'frontend bound' significant?
```
Interpret counters using the target PMU documentation and a controlled experiment. Low front-end pressure makes layout an unlikely priority; high pressure motivates a measured PGO or post-link trial rather than a universal sequence of fixes.

---

## 41.18 Recall and Practice — Core

**Recall card**

- Always label the layer: C++ semantics, ISA, ABI, object format, OS loader, or a particular compiler/tool version.
- On SysV AMD64, integer arguments normally begin in `rdi, rsi, rdx, rcx, r8, r9`; FP/SIMD classification uses a separate register sequence. Windows x64 and AAPCS64 differ.
- A normal SysV call site aligns `rsp` to 16 bytes; entry is 8 modulo 16 after the return address. The 128-byte red zone is a SysV user-space provision, not a universal x86 feature.
- Caller-saved means the caller must preserve a live value across a call; callee-saved means the callee restores it.
- Aggregate passing depends on ABI classification and C++ triviality. “MEMORY” may mean an invisible reference whose pointer is passed in a register, not necessarily object bytes pushed on the stack.
- Frame pointers and CFI are different unwind mechanisms. Neither recreates inlined or tail-called frames.
- ELF sections organize linking; program segments organize mapping. Symbols identify entities; relocations tell a linker or loader how to form addresses.
- GOT/PLT behavior, lazy binding, visibility, and symbol versions are ELF toolchain/loader rules. Inspect the final artifact.
- Retain raw addresses, module bases, build IDs, and matching debug files for production symbolization.

**Questions**

1. Given an assembly listing, which seven context labels must you establish before applying a register or layout rule?
2. Walk the annotated `sum` loop in §41.1: where are its two arguments, result, index, load, compare, and back edge?
3. Contrast SysV AMD64, Windows x64, and AAPCS64 argument passing, stack provisions, and preserved registers without treating any as C++ semantics.
4. Why can a pointer-sized non-trivial wrapper cross a SysV boundary indirectly, and why is “passed on the stack” an imprecise description?
5. Draw both unwind paths—frame-pointer chain and CFI—and list three reasons a logical source frame may be absent.
6. Distinguish an ELF section, segment, symbol, and relocation using one sentence each.
7. Trace a typical lazy ELF function call through PLT and GOT, then state what eager binding changes.
8. Which commands distinguish a compile failure, undefined link symbol, runtime loader failure, and bad production symbolization?

**Code-reading puzzle**

Assume Intel syntax and the SysV AMD64 ABI:

```asm
quote_value:
        mov     eax, edi
        imul    eax, esi
        add     eax, edx
        ret
```

Reconstruct a plausible C++ signature and expression. Then answer: why does the function need no stack frame, what does writing `eax` imply about the upper half of `rax`, and which answers would change under Windows x64? Confirm by compiling a small candidate with `-O2 -S -masm=intel`; do not expect identical instruction selection across compiler versions.

**Binary exercise**

Build the `price(int)` example in §41.11 twice: once with no definition and once with `int price(int x) { return x * 100; }` in a second translation unit.

```bash
c++ -std=c++23 -O2 -g -c main.cpp price.cpp
nm -C main.o price.o
readelf -rW main.o
c++ main.o price.o -Wl,-Map=app.map -o app
objdump -d -C app
readelf -lSWd app
```

Record how the undefined symbol and call relocation in `main.o` become a resolved address in `app`. Locate `main`, `price(int)`, the loadable segments, build ID, dynamic dependencies, and unwind section. If the host uses Mach-O or PE/COFF, perform the equivalent experiment with that platform's tools and explicitly note which ELF commands do not apply.

**Traps**

- Mixing SysV, Windows x64, Darwin, and AAPCS64 register or stack rules.
- Treating compiler-generated assembly as a C++ guarantee or one compiler version's layout as stable ABI.
- Assuming every `[rsp+N]` access is a spill, every vector register proves vectorization, or every indirect call is virtual.
- Calling a MEMORY-class aggregate “pushed on the stack” without checking invisible-reference rules.
- Writing hand assembly without correct stack alignment, clobber declarations, or unwind directives.
- Believing a truncated profiler stack without checking frame-pointer policy, CFI capture, inlining, and tail calls.
- Confusing an undefined link symbol with a runtime-loader lookup failure.
- Running `ldd` or a target loader on an untrusted executable; prefer static inspection.
- Stripping the deployed binary before archiving matching debug data and build IDs.
- Applying ELF/PLT/GOT advice to Mach-O or PE/COFF without translating the platform model.

**Prerequisite for the next chapters**

You should be able to correlate one source function with its sampled instructions, explain one call boundary and unwind path, and trace one external reference from object-file relocation through the linked and loaded image. Chapter 42 uses that evidence for CPU-conscious optimization; Chapters 43–44 use it for measurement and tooling.
