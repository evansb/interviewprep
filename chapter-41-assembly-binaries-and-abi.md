# Chapter 41 — Assembly, Binaries, and ABI

*Interview-focused revision notes. The theme: the ABI is the contract that lets separately compiled code interoperate — this chapter is that contract stated precisely, plus the ability to read the machine code and the binary container that implement it.*

---

## 41.1 Reading x86-64 Assembly

Fluency here is the difference between "the compiler did something" and "the compiler hoisted the load, kept `n` in `ecx`, and emitted a `cmov`". You do not need to write assembly; you need to read it at the speed you read C++.

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

1. **Find the prologue and frame size.** `push rbp; mov rbp, rsp; sub rsp, N` (frame pointer) or just `sub rsp, N` (omitted frame pointer, §41.16). The `N` is your stack-frame size — a large `N` in a hot function means spills or big locals.
2. **Map arguments to registers** by the SysV order (§41.5): `rdi, rsi, rdx, rcx, r8, r9` for integers/pointers, `xmm0–7` for floating point.
3. **Identify the loop.** Look for a backward jump to a label above it. The instructions between the label and the jump are the loop body; count them.
4. **Classify memory traffic.** `mov reg, [mem]` is a load, `mov [mem], reg` a store. Loads from `[rsp+N]` or `[rbp-N]` inside a loop are **spills** — a red flag.
5. **Find the calls.** `call` to a named symbol means the function was not inlined. `call [rax]` or `jmp rax` means indirect dispatch (virtual call or function pointer). No calls in a hot loop is what you want.
6. **Check for SIMD.** `xmm`/`ymm`/`zmm` registers and `v`-prefixed mnemonics (`vaddps`, `vfmadd231pd`) mean vectorization happened; `addss`/`addsd` (single element, `s` = scalar) means it did not.

```asm
; int sum(const int* a, size_t n)
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

**Reading tips that save time:**

- Compilers put the **hot path as the fall-through** and jump forward to cold code (§40.6). If you see `jne .L_cold` and the target is after the `ret`, you are looking at an error path.
- `nop` and multi-byte `nopw 0x0(%rax,%rax,1)` sequences are **alignment padding**, not code — ignore them.
- Instructions ending in `s` (scalar) vs `p` (packed): `addss` = add one float; `addps` = add four.
- `%rip`-relative addressing (`lea rax, [rip+0x2f31]`) is how PIC references globals (§41.12).
- Sizes: register name tells you the width — `rax` (64), `eax` (32), `ax` (16), `al` (8).

**Tools:** `objdump -d`, `gcc -S`, `perf annotate` (assembly with per-instruction sample counts — the single most useful view for optimization work), and Compiler Explorer (Ch. 40 §40.21) with source↔asm color mapping.

---

## 41.2 x86-64 Registers, Flags, and Addressing

### General-purpose registers

16 of them, each addressable at four widths:

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

**The 32-bit zero-extension rule is the most-asked register detail:** writing to a 32-bit register **zeroes the upper 32 bits** of the 64-bit register. Writing to a 16- or 8-bit register does *not* — it merges, creating a false dependency on the previous value (Ch. 42 §42.11). Consequences:

- `xor eax, eax` is the idiomatic 64-bit zero (2 bytes, and recognized by the renamer as a dependency-breaking idiom costing zero execution ports).
- `mov eax, edi` is a legitimate zero-extending 32→64 move; `movzx`/`movsx` are needed for narrower widths.
- Partial-register writes (`mov al, 1`) cause merge micro-ops and stalls on some cores. Prefer `movzx eax, byte ptr [..]`.

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
| AF | BCD adjust | never |

**Unsigned vs signed jumps are a reliable reading cue:** `jb`/`ja`/`jbe`/`jae` (below/above) mean the C-level comparison was **unsigned**; `jl`/`jg`/`jle`/`jge` (less/greater) mean **signed**. Spotting a `jb` where you expected a signed compare tells you an implicit conversion happened (Ch. 2 §2.3).

Note `test rax, rax` is the idiomatic "is it zero/null" (cheaper encoding than `cmp rax, 0`), and `cmp` is a `sub` that discards its result.

### Addressing modes

One instruction can compute `[base + index*scale + disp]` with scale ∈ {1,2,4,8} — this is exactly C's `array[i]` for element sizes 1/2/4/8, which is why those sizes are fast.

```asm
mov  rax, [rdi]                ; *p
mov  rax, [rdi + 8]            ; p->second_member
mov  rax, [rdi + rsi*8]        ; p[i]  for 8-byte elements
lea  rax, [rdi + rsi*8 + 16]   ; &p[i].member — ADDRESS only, no memory access
lea  rax, [rdi + rdi*2]        ; rax = rdi*3  — arithmetic abuse of LEA
mov  eax, [rip + 0x2f31]       ; RIP-relative global access (PIC)
```

**`lea` is the instruction to recognize.** It performs the address computation without touching memory, so compilers use it as a three-operand add/shift that does not clobber flags. Seeing `lea` chains means the compiler strength-reduced a multiply (Ch. 40 §40.13).

An element size that is not 1/2/4/8 (e.g. a 24-byte struct) forces an explicit `imul` before the load — one concrete reason power-of-two struct sizes matter in hot arrays (Ch. 3 §3.3).

---

## 41.3 Common Compiler Assembly Idioms

Recognizing these on sight is what makes disassembly reading fast.

| Idiom | Assembly | Meaning |
|---|---|---|
| Zero a register | `xor eax, eax` | `= 0`; dependency-breaking, zero ports |
| Null/zero test | `test rax, rax; je` | `if (!p)` |
| Sign-extend 32→64 | `movsxd rax, edi` / `cdqe` | `(int64_t)someInt` |
| Zero-extend 8/16→32 | `movzx eax, byte ptr [rdi]` | `(int)someChar` avoiding partial-register stalls |
| Multiply by constant | `lea rax,[rdi+rdi*4]; shl rax,2` | `x * 20` strength-reduced |
| **Divide by constant** | `mov rax, 0x51EB851EB851EB85; mul rsi; shr rdx, 5` | `/ 100` via magic reciprocal — *not* a crypto constant |
| Modulo by power of 2 | `and eax, 63` | `% 64` on unsigned |
| Signed `/2` | `mov eax,edi; shr eax,31; add eax,edi; sar eax,1` | Rounding-toward-zero correction — signed division is more expensive than unsigned |
| Branchless select | `test/cmp ...; cmov ge rax, rcx` | ternary or `std::max` compiled branchlessly (Ch. 42 §42.4) |
| Boolean materialize | `setne al; movzx eax, al` | `bool b = (x != y)` |
| Memory clear | `rep stosq` or `vpxor`+`vmovdqu` loops | `memset`/value-init |
| Bulk copy | `rep movsb` (ERMSB) or SIMD loop | `memcpy`/struct copy |
| Vtable call | `mov rax,[rdi]; call [rax+16]` | virtual dispatch: load vptr, call slot 2 |
| Bounds-check pair | `cmp rsi, [rdi+8]; jae .throw` | `vector::at` / `span` check |
| PIC global | `mov rax, [rip+0x1234]` | position-independent data access |
| External call via PLT | `call foo@PLT` | dynamic symbol, first call goes through the resolver (§41.12) |
| Stack protector | `mov rax, fs:0x28; ... xor rax, fs:0x28; jne __stack_chk_fail` | `-fstack-protector` canary |
| TLS access | `mov rax, fs:[0xfffffff8]` or `__tls_get_addr` | `thread_local` (Ch. 24 §24.3) — initial-exec vs general-dynamic model |
| Atomic RMW | `lock xadd [rdi], eax` | `fetch_add`; `lock` prefix = ~20 cycles uncontended (Ch. 29 §29.16) |
| Full fence | `mfence` or `lock or [rsp], 0` | `seq_cst` fence; compilers prefer the `lock` form as it is faster |
| Timestamp | `rdtsc` / `rdtscp` / `lfence; rdtsc` | Ch. 43 §43.12 |
| Alignment padding | `nopw 0x0(%rax,%rax,1)` | not executed on the hot path |

**Two worth expanding:**

**Division by a constant.** The compiler replaces `x / d` with a multiply-high by `⌈2^k/d⌉` plus shifts, because `div` is 20–40+ cycles and never pipelined while `mul` is 3 cycles. If you see a large hex constant followed by `mul`/`imul` and a `shr`, it is a division. Conversely, **division by a runtime value cannot be optimized** — a `div` in a hot loop is often the single largest cost, and hoisting to a reciprocal multiply (or restructuring so the divisor is a compile-time constant, e.g. via a template parameter) is a real optimization.

**The `lock` prefix.** `lock xadd`, `lock cmpxchg`, `lock add` are your atomics. Any `lock`-prefixed instruction in a hot loop is a serialization point and a cache-line ownership request (Ch. 29 §29.16). Counting `lock` instructions in a disassembled hot path is a fast audit for accidental atomics — e.g. a `shared_ptr` copy hiding in a "cheap" function shows up as a `lock xadd` pair (Ch. 9 §9.11).

---

## 41.4 AArch64 Assembly Fundamentals

ARM64 matters for Apple Silicon development machines, Graviton/Ampere servers, and because contrasting the two ISAs is a common way to test whether you understand *why* x86 code looks the way it does.

**Registers:** 31 general-purpose, `x0–x30` (64-bit) / `w0–w30` (32-bit, zero-extending on write, like x86's 32-bit rule). `x31` is context-dependent: `sp` (stack pointer) or `xzr`/`wzr` (the **zero register**, which reads as 0 and discards writes). `x30` = `lr`, the **link register**. 32 vector registers `v0–v31` (128-bit NEON, or SVE's scalable `z0–z31`).

**The architectural contrasts that explain everything:**

| | x86-64 | AArch64 |
|---|---|---|
| Type | CISC, variable length (1–15 bytes) | RISC, fixed 4-byte instructions |
| Memory operands | Most instructions can access memory | **Load/store only** — arithmetic is register-to-register |
| Registers | 16 GP | 31 GP (far fewer spills) |
| Flags | Almost every ALU op sets flags | Only `S`-suffixed forms (`adds`, `subs`, `cmp`) set flags |
| Return address | Pushed on stack by `call` | Placed in `lr` (`x30`) by `bl`; leaf functions never touch the stack |
| Memory model | **TSO** — strong (Ch. 29 §29.13) | **Weakly ordered** — needs explicit barriers (Ch. 29 §29.14) |
| Atomics | `lock` prefix, or `cmpxchg` | `ldxr`/`stxr` LL-SC pairs, or LSE (`ldadd`, `casal`) since ARMv8.1 |
| Unaligned access | Allowed (penalty on line/page straddle) | Allowed for normal memory, **faults** for device memory and exclusives |
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

**Points that appear in interviews:**

- **The weak memory model is the practical difference.** Code with a missing `std::atomic` or a wrong memory order that works on x86 (where TSO gives you acquire/release almost for free) breaks on ARM. Porting to Graviton is a classic way latent memory-model bugs surface (Ch. 25 §25.19).
- **`stp`/`ldp`** (store/load pair) move two registers at once and dominate prologues/epilogues: `stp x29, x30, [sp, #-16]!` pushes the frame pointer and link register with pre-decrement.
- **AAPCS64 calling convention:** `x0–x7` for the first 8 integer args, `v0–v7` for FP/SIMD, return in `x0`/`v0`, callee-saved `x19–x28` and `v8–v15` (low 64 bits only). Stack must be **16-byte aligned at all times**, not just at calls — stricter than SysV. **No red zone** in AAPCS64 (Apple's ABI variants differ in other details, notably variadic argument passing).
- **Apple Silicon specifics:** 128-byte cache lines (vs 64 on x86) matter for `alignas` and false-sharing padding (Ch. 3 §3.3); and Rosetta 2's ability to run x86 binaries relies on hardware TSO-emulation support.

---

## 41.5 System V AMD64 Calling Convention

The **System V AMD64 ABI** governs Linux, macOS, and the BSDs (Windows x64 differs — see the table below). This is the most likely single thing to be asked in detail.

### Argument passing

Arguments are classified by type into classes, then assigned to registers in order:

| Class | Registers, in order |
|---|---|
| INTEGER (integers, pointers, `bool`, enums) | `rdi, rsi, rdx, rcx, r8, r9` |
| SSE (`float`, `double`, small vectors) | `xmm0, xmm1, ..., xmm7` |
| MEMORY (anything too large or unsuitable) | Pushed on the stack, right to left |

The two sequences are **independent counters**: in `void f(int a, double b, int c, double d)`, `a`→`rdi`, `c`→`rsi`, `b`→`xmm0`, `d`→`xmm1`. Mixing does not consume the other class's slots. This trips people up constantly.

Once the six INTEGER registers are exhausted, remaining INTEGER arguments go on the stack — even if SSE registers are free.

```cpp
void f(int a, long b, void* c, char d, int e, int f, int g, double h);
// a→edi  b→rsi  c→rdx  d→ecx  e→r8d  f→r9d  g→[rsp]  h→xmm0
```

### Return values

| Return type | Location |
|---|---|
| Integer/pointer ≤ 64 bits | `rax` |
| Integer 65–128 bits (e.g. `__int128`, small struct of two words) | `rax:rdx` |
| `float`/`double` | `xmm0` |
| Two FP values (e.g. `struct {double,double}`) | `xmm0:xmm1` |
| Large or non-trivial types | **Hidden pointer**: caller allocates space, passes its address as an *implicit first argument* in `rdi` (shifting all real arguments right by one), and the callee returns that same pointer in `rax` (§41.8) |

### Other rules

- **`this` is passed as the first INTEGER argument** (`rdi`) for non-static member functions, before all declared arguments. With a hidden return pointer, the order is: hidden pointer in `rdi`, `this` in `rsi`.
- **Variadic functions** require `al` to hold *the number of SSE registers used* (0–8) — this is why calling a varargs function through a wrong prototype (e.g. `printf` without `<cstdio>`'s declaration) can crash: the callee saves `xmm0–7` to its register save area only if `al` says to.
- **Direction flag (DF)** must be clear on entry and exit.
- **The x87 stack** must be empty on entry/exit; `mxcsr` and the x87 control word are callee-saved (which is one reason `-ffast-math`'s FTZ/DAZ setting is global and sticky).

### SysV vs Windows x64

| | SysV AMD64 | Windows x64 |
|---|---|---|
| Integer args | `rdi, rsi, rdx, rcx, r8, r9` (6) | `rcx, rdx, r8, r9` (4) |
| FP args | `xmm0–7` (8) | `xmm0–3` (4) |
| Int/FP slots | Independent counters | **Positional** — a `double` in position 3 uses `xmm2` and *blocks* `r8` |
| Shadow space | None | Caller reserves **32 bytes** for the callee to spill the 4 register args |
| Red zone | **128 bytes** | None |
| Callee-saved | `rbx, rbp, r12–r15` | `rbx, rbp, rdi, rsi, r12–r15, xmm6–15` |
| Struct return | By value in registers if ≤16 B and classifiable | By hidden pointer unless 1/2/4/8 bytes |

The register-count difference is a real performance difference: SysV passes 6 integer arguments in registers to Windows' 4, and Windows must reserve shadow space on every call.

---

## 41.6 Stack Alignment and the Red Zone

### The 16-byte alignment rule

**At the point of a `call` instruction, `rsp` must be 16-byte aligned.** The `call` then pushes an 8-byte return address, so **on entry to the callee `rsp ≡ 8 (mod 16)`**. This is the precise statement; getting the off-by-8 right is the mark of someone who has actually debugged it.

```
                 rsp % 16 == 0     ← required before `call`
call pushes RIP: rsp % 16 == 8     ← state at callee entry
push rbp:        rsp % 16 == 0     ← standard prologue restores alignment
```

**Why it exists:** so that 16-byte-aligned SIMD spills (`movaps [rsp+N], xmm0`) are legal without dynamic realignment. `movaps` on a misaligned address **faults with SIGSEGV** (Ch. 3 §3.3).

**How it breaks in practice:** hand-written assembly or a JIT that calls into C code without aligning; a signal handler on a misaligned stack; an odd number of pushes before a call. The signature is a **crash inside `memcpy`, `printf`, or any libc routine that uses SSE**, at an instruction like `movaps`, with a fault address that is 8 mod 16. Nearly every "crash inside memcpy" that is not a buffer overrun is a stack-alignment bug.

`-mpreferred-stack-boundary=N` and `-mstackrealign` exist for interop with code that violates the rule; `alignas(32)` locals force the compiler to emit a dynamic realignment sequence (`and rsp, -32`) plus a frame pointer.

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

**Why it matters:** a **leaf function** (one that makes no calls) can use up to 128 bytes of locals with no prologue and no epilogue at all — no `sub rsp, N` / `add rsp, N`. Two instructions saved on every call to a small leaf function, which for accessors and hot helpers is meaningful.

```asm
; leaf using the red zone — note the absence of any rsp adjustment
f:      mov     QWORD PTR [rsp-8], rdi
        mov     QWORD PTR [rsp-16], rsi
        ...
        ret
```

**Where the red zone does not exist or must be disabled:**

- **Kernel code.** Interrupts push onto the current stack, clobbering the red zone. The Linux kernel is built with `-mno-red-zone` — a classic interview question ("why does the kernel disable the red zone?").
- **Signal handlers** in user space are safe, because the kernel's signal delivery explicitly skips 128 bytes below `rsp` when building the signal frame. That skip *is* the red zone guarantee.
- **Windows x64** has no red zone.
- **Interrupt/exception handler attributes** (`__attribute__((interrupt))`) imply `-mno-red-zone`.

A related trap: **inline assembly that writes below `rsp`** without accounting for the red zone corrupts the compiler's scratch data, producing corruption that only appears in optimized builds where the compiler chose to use the red zone.

---

## 41.7 Caller-Saved and Callee-Saved Registers

The register-preservation contract, which determines what a function may assume survives a call.

| Class | Registers | Rule |
|---|---|---|
| **Callee-saved** (non-volatile) | `rbx, rbp, r12, r13, r14, r15` | The callee must restore them before returning. The caller may hold live values across a call. |
| **Caller-saved** (volatile / scratch) | `rax, rcx, rdx, rsi, rdi, r8–r11`, **all `xmm`/`ymm`/`zmm`** | The callee may destroy them. The caller must spill anything it needs across a call. |
| Special | `rsp` (restored by convention), `rbp` (callee-saved, frame pointer if used) | |

**The fact people miss: on SysV, *all* vector registers are caller-saved.** Any function call in the middle of a vectorized loop forces the compiler to spill up to 16 `ymm` registers (512 bytes) to the stack and reload them. This is a large part of why a non-inlined call inside a hot loop is so damaging (Ch. 40 §40.16) — it is not just the call, it is the register-file evacuation. On Windows x64, `xmm6–xmm15` are callee-saved, which shifts the cost but does not remove it.

**Consequences for code generation:**

- A **leaf function** using ≤6 values can run entirely in caller-saved registers with no push/pop at all.
- A function with a loop and a call inside it will push `rbx`/`r12`–`r15` in the prologue so it has stable registers across the call — you can read the number of pushes as "how many values this function needs to keep live across calls".
- **Register pressure** is why aggressive inlining can backfire (Ch. 40 §40.4): with only 16 GP registers, inlining several functions into one body exhausts them and the allocator spills.

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
asm volatile("rdtsc" : "=a"(lo), "=d"(hi));            // declares rax, rdx written
asm volatile("cpuid" : : "a"(0) : "rbx","rcx","rdx");  // cpuid clobbers rbx — MUST declare
asm volatile("" ::: "memory");                          // compiler barrier only (Ch. 25 §25.16)
```
Omitting a clobber produces miscompilation that appears only under optimization — the compiler keeps a value in `rbx` across your asm and reads garbage.

---

## 41.8 Structure Parameter and Return ABI

How aggregates are passed is where the ABI meets C++ class design, and it produces one of the best interview answers in the language (Ch. 3 §3.5).

### The SysV classification algorithm

1. If the aggregate is **larger than 16 bytes**, or contains unaligned fields, it is class **MEMORY**.
2. If it has a **non-trivial copy constructor, move constructor, or destructor**, it is class **MEMORY** — regardless of size.
3. Otherwise, split it into two 8-byte "eightbytes" and classify each: all-float ⇒ SSE, anything integer/pointer ⇒ INTEGER.
4. Pass each eightbyte in the next register of its class, or the whole thing in MEMORY if registers run out.

```cpp
struct A { int x, y; };                  // 8 B, INTEGER      → one register (rdi)
struct B { double x, y; };               // 16 B, SSE,SSE     → xmm0, xmm1
struct C { long x; double y; };          // 16 B, INTEGER,SSE → rdi, xmm0
struct D { long a, b, c; };              // 24 B > 16         → MEMORY (stack)
struct E { long x; ~E(); };              // 8 B but non-trivial dtor → MEMORY
struct F { std::unique_ptr<int> p; };    // 8 B, non-trivial  → MEMORY
```

**Rule 2 is the money detail.** `struct E` and `struct F` are pointer-sized but must be passed **in memory** — the caller allocates a slot, copies the value there, and passes its address. The canonical statement:

> **`std::unique_ptr<T>` is not zero-overhead at ABI boundaries.** It is exactly one pointer, but because it has a non-trivial destructor it is passed on the stack, while a raw `T*` is passed in a register. Across a non-inlined call this is a real, measurable difference.

The same argument covers `std::optional<T>` with non-trivial `T`, `std::string`, and any RAII wrapper. Inside a TU, inlining makes this vanish — the cost is at **non-inlined boundaries**, which is exactly what LTO (Ch. 40 §40.3) reduces.

### Return values

- ≤16 bytes and trivially copyable ⇒ returned in `rax:rdx` and/or `xmm0:xmm1` by the same classification.
- Otherwise ⇒ **hidden return pointer (sret)**: the caller allocates the storage, passes its address as an implicit first argument in `rdi`, and the callee returns that pointer in `rax`.

```asm
; Big make_big();   →  Big* make_big(Big* hidden_ret)
call    make_big     ; rdi = &result_storage in the caller's frame
```

This is why **NRVO and guaranteed copy elision** are so effective (Ch. 10 §10.1): with the hidden pointer, the callee constructs *directly into the caller's storage*, so there is genuinely no copy or move — it is an ABI-level property, not an optimization the compiler chooses. When NRVO fails (multiple return objects, returning a parameter), you get a real move into `*hidden`.

### ABI-visible design rules

- Keep small value types **trivially copyable** if they cross non-inlined boundaries; a destructor costs you register passing.
- Keep hot aggregates **≤16 bytes** with 8-byte-classifiable halves.
- Beware mixed classes: `struct { float a; int b; }` is 8 bytes but classifies as INTEGER (an eightbyte with any integer member is INTEGER), so it travels in a GP register and needs moves to get into an FP register.
- **Bit-fields, `[[no_unique_address]]`, and empty bases** all participate in classification and have caused real cross-compiler ABI bugs. GCC and Clang have shipped mutually incompatible `[[no_unique_address]]` and empty-struct-in-C classifications; `-Wpsabi` warns about the ones GCC knows it changed.

---

## 41.9 Tail Calls

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

- Saves the `call`/`ret` pair (~2 cycles) and, more importantly, saves a stack frame — so **tail recursion becomes O(1) stack** instead of O(n), eliminating stack overflow on deep recursion.
- Reduces stack traffic and improves I-cache locality in dispatch chains.
- It is the enabling transformation for **continuation-passing dispatch** in interpreters and protocol state machines: each handler `jmp`s to the next, so the CPU's return-stack-buffer is not thrashed and there is no frame growth. Some high-performance parsers (and the "computed goto"/tail-call interpreter loop pattern) rely on it heavily.

**What defeats tail-call optimization** — this is the interview content:

| Blocker | Why |
|---|---|
| A local whose address escapes into the callee | The frame cannot be destroyed before the callee runs |
| Any non-trivially-destructible local | The destructor must run *after* the call returns, so the call isn't in tail position |
| A `try`/`catch` or any active cleanup scope | Unwinding state must survive |
| The callee returns a different type / needs a hidden sret pointer mismatch | Frame layouts incompatible |
| Variadic callee, or caller with stack arguments smaller than the callee's | The argument area cannot be reused |
| `-O0` | No such transformation |
| Sanitizers, `-fno-optimize-sibling-calls` | Explicitly disabled to preserve stack traces |

The **destructor blocker is the C++-specific one and the most commonly missed**:

```cpp
int f(int x) { std::string s = make(); return g(x); }   // NOT a tail call: ~s runs after g
int f(int x) { { std::string s = make(); use(s); } return g(x); }  // IS one: scope closed first
```

**Flags and attributes:** `-foptimize-sibling-calls` (on at `-O2`), `[[clang::musttail]] return f(args);` which is a *guaranteed* tail call — a compile error if impossible — and is the tool for writing interpreter dispatch loops that must not grow the stack. GCC has no `musttail` equivalent as of GCC 14.

**Cost:** tail calls **destroy stack traces**. The intermediate frame is gone, so `perf`, gdb, and your crash handler show `g` called directly from `f`'s caller (Ch. 58 §58.5). Debug builds and profiling builds commonly use `-fno-optimize-sibling-calls` for this reason. Also note that a `jmp` to a PLT stub interacts with the return-stack-buffer predictor: a `call`/`ret` imbalance from mixing tail calls and normal calls can cause RSB mispredictions (Ch. 27 §27.9).

---

## 41.10 ELF Sections and Segments

**ELF** (Executable and Linkable Format) is the container on Linux. The single most important idea: **sections are for the linker; segments are for the loader.** The same bytes are described twice.

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
| `.bss` | Zero-initialized globals — **occupies no file space**, mapped from `/dev/zero`. This is why a 1 GB static array does not make a 1 GB binary. |
| `.rodata.cst*`, `.rodata.str1.*` | Mergeable constant/string pools (dedup via `SHF_MERGE`) |
| `.init_array` / `.fini_array` | Pointers to static constructors/destructors, run by the runtime before `main` (Ch. 5 §5.9) |
| `.plt`, `.got`, `.got.plt` | Dynamic-linking indirection (§41.12) |
| `.dynamic`, `.dynsym`, `.dynstr` | Dynamic linking metadata and the exported/imported symbol table |
| `.symtab`, `.strtab` | Full static symbol table — **removed by `strip`** |
| `.rela.dyn`, `.rela.plt` | Relocations applied at load time |
| `.eh_frame`, `.eh_frame_hdr` | DWARF CFI unwind tables (§41.16) — **not** removed by `strip`, because exceptions need them |
| `.gcc_except_table` | Landing-pad and action tables for `catch` clauses |
| `.tdata`, `.tbss` | TLS initialization images |
| `.debug_*` | DWARF debug info (§41.15) |
| `.note.gnu.build-id` | The build ID used to match binaries to symbol files |
| `.comment` | Compiler version strings |

**RELRO** is worth understanding: `GNU_RELRO` marks a region (typically `.init_array`, `.dynamic`, `.got`, and `.data.rel.ro`) that the dynamic linker makes **read-only after relocations are applied**, hardening against GOT-overwrite attacks. **Full RELRO** (`-Wl,-z,relro,-z,now`) additionally resolves all PLT entries eagerly at load so `.got.plt` can be made read-only too — at the cost of slower startup for large symbol tables. **This is also a latency decision**: `-z now` (BIND_NOW) eliminates lazy first-call resolution jitter (§41.13).

**Practical numbers:** `size -A ./app` gives per-section sizes; `readelf -lW ./app` shows segments and their section mapping; `readelf -SW ./app` shows sections with flags (`A`=alloc, `X`=exec, `W`=write, `M`=merge).

---

## 41.11 ELF Symbols and Relocations

### Symbols

A **symbol** binds a name to an address (or a request for one). Each has a **binding**, a **type**, a **visibility**, and a **section index**.

| Binding | Meaning |
|---|---|
| `GLOBAL` | Visible across objects; duplicate definitions are an error |
| `LOCAL` | Internal to the object (`static`, anonymous namespace) |
| `WEAK` | Global, but may be overridden; unresolved weak references become 0 rather than an error (Ch. 1 §1.12) |

| Type | Meaning |
|---|---|
| `FUNC`, `OBJECT` | Code, data |
| `NOTYPE` | Undefined reference (`U` in `nm`) |
| `TLS` | Thread-local |
| `GNU_IFUNC` | Resolved by running a resolver function at load time (used for CPU dispatch, §40.2) |

| Visibility | Meaning |
|---|---|
| `DEFAULT` | Exported from a shared library; **interposable** by `LD_PRELOAD` |
| `HIDDEN` | Not exported; internal to the library. `-fvisibility=hidden` makes this the default. |
| `PROTECTED` | Exported but not interposable |

Hidden visibility is both a correctness and a performance tool: it shrinks the dynamic symbol table (faster load, fewer relocations), removes interposition so calls can be inlined and direct (Ch. 40 §40.3), and prevents accidental ABI exposure of internals.

**Weak symbols in practice:** `__attribute__((weak))` for optional dependencies (`if (&pthread_create) ...`), and the ODR mechanism — inline functions and template instantiations are emitted as `WEAK` in COMDAT groups (`.text._Z3fooi` with `SHF_GROUP`), so the linker keeps one copy and discards duplicates. That is how `inline` actually works at link level (Ch. 1 §1.9).

### Relocations

A **relocation** is an instruction to the linker or loader: "patch the value at offset X using symbol S and formula R". The important x86-64 types:

| Type | Meaning |
|---|---|
| `R_X86_64_PC32` | 32-bit PC-relative — normal intra-module calls and RIP-relative data |
| `R_X86_64_PLT32` | Call routed through the PLT |
| `R_X86_64_GOTPCREL` | Load the address from the GOT, RIP-relative |
| `R_X86_64_64` | Absolute 64-bit address — requires a load-time write |
| `R_X86_64_GLOB_DAT` | Fill a GOT entry with a symbol's address |
| `R_X86_64_JUMP_SLOT` | Fill a PLT's GOT entry (lazily, or eagerly with BIND_NOW) |
| `R_X86_64_RELATIVE` | Add the load base — the cheap, symbol-less relocation for internal pointers in PIE |
| `R_X86_64_COPY` | Copy a data object from a library into the executable (legacy, ABI-fragile) |
| `R_X86_64_TPOFF64`, `TLSGD` | TLS offsets |

**`R_X86_64_RELATIVE` count is a startup-latency metric.** A PIE binary with many vtables and pointer-containing globals accumulates hundreds of thousands of these, and the dynamic linker must apply every one at startup — the reason large C++ binaries can take hundreds of milliseconds to load. `DT_RELR` (relative relocation compression, glibc 2.36+/lld) encodes them as a bitmap and cuts both size and startup time substantially. For a trading process this is a real cold-start consideration (Ch. 60 §60.7).

```bash
readelf -rW ./app | head          # relocations
readelf -rW ./app | grep -c RELATIVE
nm -C --defined-only ./app        # defined symbols, demangled
nm -CD ./libfoo.so                # dynamic symbol table only
```

**Relocation errors you will meet:** *"relocation R_X86_64_32S against `.rodata` can not be used when making a PIE object; recompile with -fPIE"* — a non-PIC object linked into a PIE/shared library. *"undefined reference to `foo(int)`"* with a demangled C++ name means a declaration without a definition; the same with a C name usually means a missing `extern "C"` (Ch. 1 §1.10).

---

## 41.12 PLT, GOT, and Position-Independent Code

**Position-independent code** can execute at any load address, which is required for shared libraries and for **ASLR** on executables (PIE). The mechanism is indirection through two tables.

- **GOT (Global Offset Table)** — an array of addresses in the data segment, filled in by the dynamic linker. Code loads an address from the GOT instead of embedding it.
- **PLT (Procedure Linkage Table)** — small code stubs, one per imported function, that jump through the GOT.

### Data access

```asm
; non-PIC absolute:
mov  eax, [0x601040]          ; requires a load-time relocation, breaks sharing
; PIC, module-internal (hidden visibility or static):
mov  eax, [rip + 0x2f31]      ; RIP-relative, zero relocations at load, FREE
; PIC, possibly-interposed global:
mov  rax, [rip + got_offset]  ; load address from GOT (one extra load)
mov  eax, [rax]               ; then dereference
```

RIP-relative addressing (new in x86-64) makes PIC *nearly free for internal references* — which is why PIE is the default on modern Linux with little measured cost, unlike on 32-bit x86 where PIC cost a dedicated register (`ebx`) and a `call/pop` to discover the PC.

### Function calls and lazy binding

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

**Cost model:** first call ~microseconds (symbol lookup by hash across all loaded objects); subsequent calls one extra indirect jump — an extra load and a branch predicted by the BTB, so typically ~1–2 cycles when hot.

**For low-latency systems the lazy-binding jitter is unacceptable**: a rarely-used error path resolving a symbol during a market event costs microseconds at exactly the wrong moment. The fixes, in order of preference:

1. **`-Wl,-z,now`** (BIND_NOW) — resolve everything at load; combined with `-Wl,-z,relro` gives full RELRO and a read-only GOT. Equivalently `LD_BIND_NOW=1` at runtime.
2. **Static linking** — no PLT, no GOT for functions, no dynamic linker at all.
3. **`-fvisibility=hidden` plus `-fno-semantic-interposition`** — internal calls become direct `call` with no PLT and become inlinable (Ch. 40 §40.3).
4. **Prefault/warm the hot paths at startup** so any remaining resolution happens before trading (Ch. 60 §60.7).

**`-fPIC` vs `-fPIE`:** `-fPIC` is for shared libraries (must assume any global may be interposed); `-fPIE` is for executables (can assume symbols defined in the executable are not interposed, so it generates better code — direct RIP-relative access instead of GOT loads). `-fno-pie -no-pie` disables PIE entirely, giving marginally better code density and losing ASLR; some HFT shops do this deliberately for determinism and for stable addresses in flight recorders.

**Verification:** `objdump -d --section=.plt`, `readelf -r` for `JUMP_SLOT` entries, `LD_DEBUG=bindings ./app` to trace every symbol resolution, and `checksec --file=./app` for a quick RELRO/PIE/BIND_NOW summary.

---

## 41.13 Dynamic Linking

The **dynamic linker** (`/lib64/ld-linux-x86-64.so.2`, named in the `PT_INTERP` program header) runs before `main` and is responsible for loading dependencies, applying relocations, and running initializers.

**The startup sequence:**

1. Kernel maps the executable's `PT_LOAD` segments and the interpreter, then jumps to the interpreter.
2. `ld.so` reads `DT_NEEDED` entries and loads each library, recursively, honoring `DT_RPATH`/`DT_RUNPATH`, `LD_LIBRARY_PATH`, `/etc/ld.so.cache`, then default paths.
3. Relocations are applied per object (`R_X86_64_RELATIVE` first, then symbol-based ones).
4. RELRO regions are `mprotect`ed read-only.
5. TLS blocks are set up; `.init_array` entries run in dependency order — this is where your static constructors execute.
6. Control passes to `_start` → `__libc_start_main` → `main`.

**Symbol resolution order and interposition.** Lookup proceeds in **breadth-first load order**, and the *first* definition found wins globally. This is why `LD_PRELOAD` works: a preloaded object is placed first in the search order, so its `malloc` displaces libc's. It is also the source of subtle bugs where two libraries define the same symbol and one silently wins.

**Versioning.** glibc uses symbol versioning (`memcpy@GLIBC_2.14`) so that an ABI change can coexist with the old behavior. Two consequences:

- A binary built against a newer glibc will not run on an older one — the classic *"`version GLIBC_2.34' not found`"*. The reverse (old binary, new glibc) generally works. Build on the oldest supported target, or use a sysroot/container.
- Your own libraries can use a version script (`-Wl,--version-script=`) to control exports precisely — the professional way to manage a library ABI (Ch. 44 §44.17).

**`dlopen`/`dlsym`** for runtime loading: note that `dlopen`ing a plugin defeats whole-program devirtualization (Ch. 40 §40.18) because a new derived class can appear at runtime; and that symbols reachable only via `dlsym` need `used`/`retain` or they are collected by `--gc-sections` (Ch. 40 §40.20).

**Static vs dynamic for low-latency systems:**

| | Static | Dynamic |
|---|---|---|
| Startup | Fast — no relocation storm, no symbol resolution | Slower; hundreds of ms for large C++ binaries |
| Call cost | Direct `call`, fully inlinable with LTO | PLT indirection unless hidden/BIND_NOW |
| Deployment | One self-contained artifact; trivially reproducible | Version skew risk across hosts |
| Memory | Each process has its own copy | `.text` shared across processes |
| Updates | Relink and redeploy | Swap a `.so` |
| Caveats | `getaddrinfo`/NSS and `dlopen` do not work fully statically with glibc; consider musl | — |

Trading systems overwhelmingly prefer **static linking** (or minimal dynamic dependencies with `-z now`) for deterministic startup, reproducible artifacts, and full LTO across the whole program (Ch. 60 §60.1).

**Diagnostics:** `ldd ./app` (dependencies — note it *executes* the binary's loader, so never run it on untrusted files), `LD_DEBUG=libs,bindings,statistics ./app`, `readelf -d ./app` for `DT_NEEDED`/`RUNPATH`, and `ltrace` for library-call tracing (Ch. 34 §34.6).

---

## 41.14 Binary Inspection Tools

Know what each tool *reveals*; the tool choice is usually the first half of a good answer.

| Tool | Reveals | Canonical invocation |
|---|---|---|
| **`objdump`** | Disassembly, section contents, relocations, headers | `objdump -d -C -M intel --no-show-raw-insn ./app`<br>`objdump -dS ./app` (source-interleaved, needs `-g`)<br>`objdump -R ./app` (dynamic relocations) |
| **`readelf`** | Everything ELF, without disassembling | `readelf -hSlWd ./app` (header, sections, segments, dynamic)<br>`readelf -rW`, `readelf -n` (notes/build-id) |
| **`nm`** | Symbol table with type letters | `nm -C --defined-only --size-sort -S ./app`<br>`nm -CDu ./lib.so` (undefined dynamic symbols) |
| **`c++filt`** | Demangles Itanium C++ names | `echo _ZNSt6vectorIiSaIiEE9push_backEOi \| c++filt` |
| **`strings`** | Embedded literals; quick version/config discovery | `strings -n 8 ./app` |
| **`size`** | Per-section sizes — the metric for `-O3`/ICF/`--gc-sections` effects | `size -A ./app` |
| **`ldd`** | Shared-library dependency resolution | `ldd ./app` |
| **`strip`** / `objcopy` | Remove/split debug info | `objcopy --only-keep-debug app app.dbg; strip -g app; objcopy --add-gnu-debuglink=app.dbg app` |
| **`addr2line`** | Address → file:line, including inline frames | `addr2line -Cfie ./app 0x4011a6` |
| **`perf`** | Where time goes, at instruction granularity | `perf record -g ./app; perf annotate` |
| **`llvm-mca`** | Static throughput/port-pressure model of a code block | `llvm-mca -mcpu=skylake asm.s` |
| **`pahole`** | Struct layout, holes, cacheline crossings (Ch. 3 §3.4) | `pahole -C Order ./app` |
| **`bloaty`** | Attributes binary size to symbols/sections/compile units | `bloaty -d compileunits ./app` |
| **`checksec`** | RELRO, PIE, NX, stack canary, BIND_NOW status | `checksec --file=./app` |
| **`gdb`** | Live disassembly and register state | `disassemble /s`, `info registers`, `x/16i $pc` |

**`nm` symbol letters** worth memorizing: `T` text (global), `t` text (local), `D`/`d` initialized data, `B`/`b` bss, `R`/`r` rodata, `U` undefined, `W`/`w` weak, `V`/`v` weak object, `i` indirect (IFUNC).

**Common workflows:**

```bash
# Did this function get inlined away?
nm -C ./app | grep -c 'parse_message'

# What ISA extensions did we actually emit?
objdump -d ./app | grep -oE '\bv[a-z0-9]+\b' | sort -u | head

# Why is the binary 400 MB?
bloaty -d compileunits,symbols ./app | head -30

# Which library is a symbol coming from?
LD_DEBUG=bindings ./app 2>&1 | grep 'binding file.*malloc'

# What does this hot loop actually cost?
perf record -e cycles:pp ./app && perf annotate --stdio parse_message
```

---

## 41.15 Debug Information and Symbolization

**Symbolization** is turning an address into `function (file:line)`. It requires two independent things: a **symbol table** (address → name) and **DWARF debug info** (address → file, line, inline stack, variable locations).

**`-g` levels:**

| Flag | Contents |
|---|---|
| `-g0` | None |
| `-g1` / `-gmlt` / `-gline-tables-only` | Line tables and function boundaries only — enough for backtraces and AutoFDO, small |
| `-g` (`-g2`) | Full: types, variables, locations, inline stacks |
| `-g3` | Plus macro definitions |
| `-gsplit-dwarf` | Emit `.dwo` files separately; the binary keeps only a skeleton (§ below) |
| `-gz` | Compress `.debug_*` sections |

**Full `-g` on an optimized build costs nothing at runtime** — DWARF lives in non-`SHF_ALLOC` sections, so it is never loaded into memory at execution. It costs disk and link time only. **`-O2 -g` is the correct production build**, and shipping without debug info is a false economy that makes production crashes unanalyzable.

**Split DWARF** solves the link-time and size problem: `-gsplit-dwarf` puts debug data in per-object `.dwo` files, so the linker copies far less; combine with `-Wl,--gdb-index` or `gdb-add-index` for fast symbol lookup. The `dwp` tool packages them.

**The separate-debug-file workflow** (what distributions and serious shops do):

```bash
g++ -O2 -g ... -o app
objcopy --only-keep-debug app app.debug
strip --strip-debug --strip-unneeded app
objcopy --add-gnu-debuglink=app.debug app
```
Now `app` is small, and gdb finds `app.debug` via the debuglink or via the **build ID** (`readelf -n app` → `.note.gnu.build-id`), which is the robust mechanism: symbol servers index by build ID, so a core dump from any build can be symbolized against the matching debug file (Ch. 58 §58.8). **Store debug files for every deployed build, keyed by build ID** — the single most valuable operational practice in this section.

**Symbolizing optimized code — the hard parts:**

- **Inlining destroys the naive mapping.** One address belongs to several source locations (the inline stack). `addr2line -i` (or `-Cfie`) prints the full stack; `llvm-symbolizer` does the same and is faster. A backtrace that omits inline frames is misleading, and `perf` needs `--inline` to show them.
- **Variables are "optimized out"** because their locations are register-based and change per-instruction. DWARF location lists express this, but gdb will still report values as unavailable in ranges where they are dead.
- **Line attribution is approximate** — instructions are scheduled across statement boundaries, so a breakpoint may land somewhere surprising. `-Og` mitigates it (Ch. 40 §40.1).
- **Tail calls remove frames entirely** (§41.9).
- **BOLT and post-link tools** rewrite addresses; they must update DWARF, and historically did so imperfectly (Ch. 40 §40.11). Validate symbolization on the final shipped artifact, not on the pre-BOLT one.

**Runtime symbolization inside your own process** (crash handlers, flight recorders): `backtrace()`/`backtrace_symbols()` from glibc gives only dynamic symbols and allocates; `libunwind` or C++23 `std::stacktrace` is better; the safest production pattern is to record **raw addresses plus the build ID** in the crash log and symbolize offline, because symbolization in a signal handler is not async-signal-safe (Ch. 33 §33.15, Ch. 58 §58.13).

---

## 41.16 Stack Unwinding and Frame Pointers

**Unwinding** is walking the chain of active stack frames. It is needed for exception propagation, backtraces, and profiler call graphs. Two mechanisms exist and they have very different properties.

### Frame pointers

With `-fno-omit-frame-pointer`, every function's prologue does `push rbp; mov rbp, rsp`, creating a linked list:

```
   rbp ──► [saved rbp] ──► [saved rbp] ──► ...
           [return addr]   [return addr]
```
Walking it is trivial and fast: two loads per frame, no metadata, works from a signal handler, works even with a corrupted heap.

**Cost:** two instructions per call, plus the loss of `rbp` as a general-purpose register — which on x86-64's 16-register file is roughly a 1–2% penalty (measured; older claims of 5–10% come from 32-bit x86 with 8 registers). The kernel/distro consensus has shifted: Fedora and Ubuntu now build with frame pointers enabled by default precisely because continuous profiling is worth more than 1%.

### DWARF CFI (`.eh_frame`)

The compiler emits **Call Frame Information**: a table describing, for every instruction address, how to compute the caller's `rsp` and where each callee-saved register was spilled. This works with `rbp` omitted and is what C++ exceptions use.

**Cost:** unwinding requires parsing a table (a binary search in `.eh_frame_hdr` then interpreting a bytecode program per frame) — **orders of magnitude slower** than frame-pointer walking, and it allocates and takes a global lock in some libgcc paths. Fine for exceptions (rare) and offline analysis; problematic for high-frequency sampling.

| | Frame pointers | DWARF CFI | ORC (kernel) | LBR / SHADOW_STACK |
|---|---|---|---|---|
| Runtime cost | ~1–2% always | Zero when not unwinding | Zero | Zero |
| Unwind speed | Very fast | Slow | Fast | Instant |
| Depth limit | Unlimited | Unlimited | Unlimited | 16–32 entries (LBR) |
| Works in signal handler | Yes | Risky (locks, allocation) | N/A | Yes |
| Works with optimized code | Only if enabled | Yes | Yes | Yes |
| `perf` flag | `--call-graph fp` | `--call-graph dwarf` | — | `--call-graph lbr` |

`perf --call-graph dwarf` copies a chunk of the stack (default 8 KB) with every sample and unwinds offline — accurate, but it produces enormous `perf.data` files and high sampling overhead. `--call-graph lbr` is nearly free but capped at LBR depth. For a latency-sensitive service being profiled in production, **frame pointers plus `--call-graph fp`** is usually the right tradeoff.

**Exception-handling implications** (Ch. 10 §10.7): the "zero-cost" model means no runtime cost on the non-throwing path — the cost is entirely in `.eh_frame`/`.gcc_except_table` size and in the *throwing* path, where unwinding is expensive (microseconds, plus a global mutex in some libstdc++ versions when looking up FDEs in a dynamically-loaded object). This is the concrete basis for "never throw on the hot path" and for `-fno-exceptions` in some trading codebases.

**Diagnostic signature:** broken or truncated stacks in `perf report` (showing only one or two frames) almost always means frame pointers are omitted and you used `--call-graph fp`. Stacks that are correct but sampling that is unbearably slow means `--call-graph dwarf`. Missing intermediate frames with otherwise-good stacks means tail calls or inlining (use `--inline`, or `-fno-optimize-sibling-calls`).

---

## 41.17 Code Layout and Cold Splitting

Instruction fetch is a memory access, so code has cache and TLB behavior exactly as data does — and unlike data, you can rearrange it freely without changing semantics. Front-end stalls are a large fraction of the cost in big C++ services (Ch. 27 §27.15).

**The resources being managed:**

| Resource | Typical size | Failure signature |
|---|---|---|
| L1 instruction cache | 32 KB, 8-way | `L1-icache-load-misses`, `frontend_bound` |
| Micro-op cache (DSB) | ~1536 µops, strict per-32B-window limits | `idq.dsb_uops` low vs `idq.mite_uops` |
| iTLB | 128–256 entries × 4 KB = 0.5–1 MB coverage | `iTLB-load-misses` |
| Branch target buffer | Thousands of entries | `br_misp_retired.indirect` |
| Instruction fetch granularity | 16–32 bytes per cycle | Hot loop straddling a 32 B boundary |

A 50 MB binary with a hot path scattered across dozens of translation units touches far more instruction pages than necessary; each cold function interleaved with hot code wastes most of a 64-byte line and a whole TLB entry.

**The layout transformations, in order of leverage:**

1. **Hot/cold splitting.** Move cold basic blocks out of hot functions into `.text.unlikely`. Driven by PGO, `[[gnu::cold]]`, `[[unlikely]]`, or `-freorder-blocks-and-partition`. The hot path becomes contiguous, straight-line, taken-branch-free code.
2. **Basic-block reordering** so the likely successor is the fall-through (Ch. 40 §40.6).
3. **Function reordering** so callers and callees are adjacent — `hfsort+` in BOLT, `-Wl,--symbol-ordering-file=` in lld, or `[[gnu::section("...")]]` by hand.
4. **Huge pages for `.text`.** Backing the hot code region with 2 MB pages collapses hundreds of iTLB entries into one. BOLT's `-hugify`, or manual `madvise(MADV_HUGEPAGE)` remapping of the text segment at startup. Worth several percent on large binaries (Ch. 32 §32.10).
5. **Loop alignment** — `-falign-loops=32`, and `-mbranches-within-32B-boundaries` for the Skylake JCC erratum (Ch. 40 §40.15).

**The manual C++ pattern**, which you should be able to write from memory:

```cpp
// Cold slow path: separate function, never inlined, marked cold, so the
// compiler emits it into .text.unlikely and predicts the branch not-taken.
[[gnu::noinline, gnu::cold]]
void handle_sequence_gap(Session&, Seq expected, Seq got);

inline void on_message(Session& s, const Msg& m) noexcept {
    if (m.seq != s.expected) [[unlikely]] {         // layout hint
        handle_sequence_gap(s, s.expected, m.seq);  // out-of-line, out-of-cache
        return;
    }
    apply(s, m);            // hot path: contiguous, no calls, no taken branches
    ++s.expected;
}
```

Everything here is deliberate: `noinline` keeps the hot function small; `cold` moves the body to a distant section *and* propagates "unlikely" to callers; `[[unlikely]]` makes the hot path the fall-through; `noexcept` avoids landing-pad edges that constrain code motion; `inline` on the hot function lets it fold into the caller's straight-line region.

**Measuring whether layout is your problem:**

```bash
perf stat -e cycles,instructions,L1-icache-load-misses,iTLB-load-misses,\
idq.dsb_uops,idq.mite_uops ./app
perf stat --topdown ./app        # is 'frontend bound' significant?
```
If `frontend_bound` is low and iTLB/icache misses are low, layout work will do nothing — spend the effort elsewhere (Ch. 43 §43.19). If it is 20–40%, the ordered fix list is: PGO → BOLT → huge-page text → manual hot/cold annotation.

---

## Key Interview Questions

1. **Give the SysV AMD64 integer argument registers in order.** — `rdi, rsi, rdx, rcx, r8, r9`; then the stack. FP args use `xmm0–7` on an *independent* counter. `this` is the first integer argument.
2. **Where is the return value?** — `rax` (integer ≤64), `rax:rdx` (up to 128), `xmm0`/`xmm0:xmm1` (FP), or via a hidden `sret` pointer in `rdi` for large/non-trivial types, returned again in `rax`.
3. **Which registers are callee-saved?** — `rbx, rbp, r12–r15` (plus `rsp` by convention). Everything else, **including all vector registers**, is caller-saved — which is why a non-inlined call inside a vectorized loop forces a mass spill.
4. **What is the stack-alignment rule, exactly?** — `rsp` is 16-byte aligned *at the `call` instruction*, so on function entry `rsp % 16 == 8` after the pushed return address. Violations crash in libc's `movaps`.
5. **What is the red zone, and why does the kernel disable it?** — 128 bytes below `rsp` usable by leaf functions without adjusting `rsp`; interrupts push onto the current kernel stack and would clobber it, hence `-mno-red-zone`.
6. **Why is `std::unique_ptr` not zero-overhead across an ABI boundary?** — A non-trivial destructor forces class MEMORY, so it is passed on the stack, whereas a raw pointer goes in a register. Inlining or LTO removes the difference; a non-inlined boundary does not.
7. **When is a struct returned in registers?** — ≤16 bytes, trivially copyable, and classifiable into two eightbytes; otherwise a hidden return pointer, which is exactly what makes NRVO/guaranteed elision free.
8. **What is a tail call and what prevents it in C++?** — Replacing `call; ret` with `jmp`, reusing the frame. Blocked by non-trivial destructors of locals, escaping local addresses, active cleanup scopes, and `-fno-optimize-sibling-calls`. `[[clang::musttail]]` makes it mandatory.
9. **You see `mov rax, 0x51EB851EB851EB85; mul; shr` — what is it?** — Division by a constant via magic-reciprocal multiply-high, because `div` is 20–40 cycles.
10. **How do you tell signed from unsigned comparison in disassembly?** — `jb/ja/jae/jbe` (below/above) are unsigned; `jl/jg/jle/jge` (less/greater) are signed.
11. **What does writing to `eax` do to `rax`?** — Zeroes the upper 32 bits. Writing to `ax`/`al` merges instead, creating a false dependency.
12. **What is `lea` for?** — Address computation without memory access; used as a three-operand add/shift that does not set flags, and it is the signature of strength-reduced multiplication.
13. **Sections vs segments in ELF?** — Sections are link-time views (`.text`, `.rodata`, `.bss`); segments (`PT_LOAD`) are the loader's view. `.bss` occupies no file space.
14. **Explain the PLT/GOT call path and its cost.** — First call jumps through the PLT stub to `_dl_runtime_resolve`, which writes the resolved address into the GOT; later calls are one indirect jump. Eliminate the first-call jitter with `-Wl,-z,now` or static linking.
15. **Why is PIC nearly free on x86-64 but expensive on 32-bit x86?** — RIP-relative addressing gives PC-relative data access in one instruction; 32-bit x86 needed a dedicated GOT base register and a `call/pop` to obtain the PC.
16. **What does `-fvisibility=hidden` buy you?** — Smaller dynamic symbol tables and faster load, no interposition (so calls become direct and inlinable), and no accidental ABI exposure. Pair with `-fno-semantic-interposition`.
17. **Difference between weak symbols and hidden visibility?** — Weak is a *binding* (overridable, may resolve to 0); hidden is a *visibility* (not exported at all). Inline functions and template instantiations are weak in COMDAT groups.
18. **What are `R_X86_64_RELATIVE` relocations and why do they matter for startup?** — Load-base additions for internal pointers in PIE binaries; large C++ binaries accumulate hundreds of thousands, dominating startup. `DT_RELR` compresses them.
19. **Frame pointers vs DWARF unwinding — which and why?** — Frame pointers cost ~1–2% but make unwinding two loads per frame and signal-safe; DWARF `.eh_frame` is free at runtime but slow to unwind and awkward under sampling. For production profiling, keep frame pointers.
20. **Why does `-O2 -g` cost nothing at runtime?** — DWARF sections are not `SHF_ALLOC`, so they are never mapped into memory during execution. Always ship with debug info (split, keyed by build ID).
21. **A backtrace is missing frames — why?** — Inlining (use `addr2line -i` / `perf --inline`), tail calls (the frame no longer exists), or omitted frame pointers with `--call-graph fp`.
22. **How would you make a big binary's hot path faster without changing the code?** — PGO, then BOLT for whole-binary block/function layout and hot/cold splitting, then huge-page-backed `.text`; verify with `perf stat --topdown` that you were front-end bound in the first place.
23. **Name the key AArch64 differences from x86-64.** — Fixed 4-byte RISC encoding, load/store architecture, 31 GP registers, link register instead of a pushed return address, a zero register, **weak memory ordering** (so x86-TSO-dependent bugs surface), LL-SC or LSE atomics, and 16-byte stack alignment at all times with no red zone.
24. **What crashes inside `memcpy` for no apparent reason?** — Usually stack misalignment: a `movaps` on an address that is 8 mod 16, caused by hand-written assembly, a JIT, or a mismatched calling convention.

---

## Common Traps

- **Confusing SysV and Windows x64 argument registers** — `rdi,rsi,...` vs `rcx,rdx,r8,r9`, and Windows' positional int/FP slots plus 32-byte shadow space.
- **Thinking integer and FP arguments share a counter on SysV.** They do not.
- **Getting the alignment rule off by 8** — it is 16-byte aligned *before* the `call`, so `rsp % 16 == 8` on entry.
- **Writing below `rsp` in inline assembly** without accounting for the red zone.
- **Forgetting `-mno-red-zone` in kernel or interrupt-context code.**
- **Omitting clobbers in inline asm** (`cpuid` clobbers `rbx`) — miscompiles that appear only with optimization.
- **Assuming a pointer-sized RAII type is passed in a register** — a non-trivial destructor forces MEMORY class.
- **Assuming writing `al` or `ax` zeroes the upper bits.** Only 32-bit writes do.
- **Reading `perf` stacks with omitted frame pointers** and believing the truncated result.
- **Expecting a tail call when a local with a destructor is in scope.**
- **Relying on tail calls for correctness without `[[clang::musttail]]`** — a debug build or a sanitizer disables them and the stack overflows.
- **Shipping stripped binaries with no archived debug info** — production crashes become unanalyzable.
- **Symbolizing without `-i`/`--inline`** and misattributing cost to the wrong function.
- **Leaving lazy PLT binding enabled** in a latency-critical process — first-call resolution jitter at the worst moment.
- **Letting `--gc-sections` collect `dlsym`-only symbols** (mark them `used`/`retain`).
- **Building against a newer glibc than the deployment target** — `version GLIBC_2.34 not found`.
- **Running `ldd` on an untrusted binary** — it invokes the binary's loader.
- **Assuming x86-TSO semantics carry to AArch64** — missing atomics and wrong memory orders surface on ARM.
- **Assuming 64-byte cache lines everywhere** — Apple Silicon uses 128, which changes `alignas` padding.
- **Deploying a BOLTed binary without re-validating symbolization and unwinding.**

---

## Compact Recall Summary

**Reading asm.** Identify syntax (AT&T `mov src,dst` vs Intel `mov dst,src`), find the prologue and frame size, map arguments to `rdi,rsi,rdx,rcx,r8,r9`/`xmm0–7`, find the backward jump that marks the loop, flag `[rsp±N]` traffic in loops as spills, treat `call` as failed inlining and `call [rax]` as indirect dispatch, and read `v`-prefixed/`ymm` mnemonics as successful vectorization.

**Registers and flags.** 16 GP registers at four widths; 32-bit writes zero-extend, narrower writes merge and create false dependencies. `xor eax,eax` zeroes; `test rax,rax` is the null check; `lea` computes addresses (and strength-reduced multiplies) without touching memory; `[base+index*scale+disp]` is native for element sizes 1/2/4/8. `jb/ja` = unsigned, `jl/jg` = signed.

**Idioms.** Magic-reciprocal `mul`+`shr` = constant division; `cmov` = branchless select; `mov rax,[rdi]; call [rax+N]` = virtual dispatch; `lock xadd` = atomic RMW (and an audit target for hidden `shared_ptr` traffic); `fs:` = TLS; `call foo@PLT` = dynamic symbol.

**AArch64.** Fixed-width RISC, load/store architecture, 31 GP registers plus a zero register, return address in `lr`/`x30`, `stp`/`ldp` pairs in prologues, `x0–x7`/`v0–v7` for arguments, callee-saved `x19–x28`, 16-byte alignment always and no red zone, LL-SC (`ldxr`/`stxr`) or LSE atomics, and a **weak** memory model that exposes latent ordering bugs that x86 TSO hides.

**SysV ABI.** Integer args `rdi,rsi,rdx,rcx,r8,r9`; FP args `xmm0–7`, independent counters; `this` first; `al` = SSE-register count for varargs. Returns in `rax`/`rax:rdx`/`xmm0(:xmm1)`, or a hidden `sret` pointer. Callee-saved: `rbx,rbp,r12–r15` only — *all* vector registers are caller-saved. `rsp % 16 == 0` at the `call`, `== 8` on entry; 128-byte red zone below `rsp` for leaf functions, absent in kernel code and on Windows.

**Aggregates.** >16 bytes or non-trivial copy/move/destructor ⇒ class MEMORY ⇒ passed on the stack; otherwise split into two eightbytes classified INTEGER or SSE. This is why `unique_ptr` is not free at ABI boundaries, and why the hidden return pointer makes NRVO and guaranteed elision genuinely zero-cost. Tail calls turn `call;ret` into `jmp`, are blocked by any non-trivially-destructible local or escaping address, destroy stack frames for debugging, and are guaranteed only by `[[clang::musttail]]`.

**ELF.** Sections are for the linker, segments (`PT_LOAD`) for the loader; `.bss` costs no file space; `.eh_frame` survives `strip` because exceptions need it; RELRO plus `-z now` makes the GOT read-only and removes lazy-binding jitter. Symbols carry binding (global/local/**weak** — how `inline` and templates work via COMDAT), type, and visibility (**hidden** shrinks the dynamic table, kills interposition, enables direct inlinable calls). `R_X86_64_RELATIVE` counts drive PIE startup time; `DT_RELR` compresses them.

**Dynamic linking.** PLT stub → GOT → `_dl_runtime_resolve` on first call, direct thereafter; kill the jitter with `-z now`, hidden visibility, or static linking. Resolution is breadth-first with first-definition-wins, which is why `LD_PRELOAD` works. glibc symbol versioning means build on the oldest supported target. Trading systems prefer static linking for deterministic startup, reproducible artifacts, and whole-program LTO.

**Tools.** `objdump` (disassembly), `readelf` (ELF structure), `nm` (symbols and sizes), `size`/`bloaty` (where the bytes went), `addr2line -Cfie`/`llvm-symbolizer` (addresses with inline stacks), `ldd`/`LD_DEBUG` (linking), `checksec` (RELRO/PIE/BIND_NOW), `perf annotate` (cost per instruction), `llvm-mca` (static port pressure), `pahole` (layout).

**Debug and unwind.** `-O2 -g` costs nothing at runtime because DWARF is not `SHF_ALLOC`; split debug files keyed by build ID and archive them for every deployment. Inlining and tail calls remove frames, so symbolize with `-i`. Frame pointers cost ~1–2% and give fast, signal-safe unwinding; DWARF CFI is free until you unwind and then slow; use `--call-graph fp` for production sampling and `lbr` where depth allows.

**Layout.** Instruction fetch is memory access: 32 KB L1i, ~1536-µop DSB, 128–256 iTLB entries. Split cold code into `.text.unlikely` (`[[gnu::cold]]` + `noinline` + `[[unlikely]]`), reorder blocks and functions by profile (PGO then BOLT `hfsort+`), and back hot `.text` with 2 MB pages. Confirm with `perf stat --topdown` that you are front-end bound before spending effort here.
