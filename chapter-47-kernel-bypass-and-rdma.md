# Chapter 47 — Kernel Bypass and RDMA

*Interview-focused revision notes. The theme: Ch. 46 established that a tuned kernel costs ~3–5 µs and a fat tail; this chapter is the set of techniques that map the NIC's rings directly into user space and delete that cost — together with the operational bill each one presents. The right answer in an interview is never "use DPDK", it is "here is the trade-off matrix and here is which cell your problem is in".*

---

## 47.1 Kernel-Bypass Motivation and Trade-offs

**Kernel bypass** means the application's user-space process reads and writes the NIC's descriptor rings directly, without a syscall, without an interrupt, and without an `sk_buff` — the kernel is involved only in setup (mapping the device's BARs and DMA-able memory into the process) and in control-plane operations.

### The cost being removed

From Ch. 46 §46.1, per received packet on a tuned kernel:

| Component | Cost | Removed by bypass? |
|---|---|---|
| NIC internal + PCIe DMA | 300–900 ns | No — physics |
| Interrupt + ISR | 1–3 µs | Yes (poll instead) |
| `sk_buff` alloc + init (2 allocations, 4 cache lines) | 300–600 ns | Yes (preallocated flat buffer) |
| Protocol demux, netfilter, routing, socket lookup | 300–800 ns | Yes (or reimplemented minimally) |
| Socket lock + queue enqueue | 200–500 ns | Yes |
| Wakeup / context switch | 1–5 µs | Yes (thread already spinning) |
| `copy_to_user` | 200–400 ns | Yes (zero-copy) |
| **Syscall entry/exit** | 50–200 ns (worse with mitigations) | Yes |

```
Tuned kernel + busy poll   : ~3–5 µs  wire-to-application, p99.9 ~50 µs
Kernel bypass (ef_vi/DPDK) : ~0.8–1.5 µs, p99.9 ~2–3 µs
FPGA (Ch. 48 §48.1)        : ~50–200 ns wire-to-wire, deterministic
```

The headline is the ~3–4 µs of mean reduction. **The real prize is the tail**: bypass removes every scheduling decision from the data path, so the distribution collapses from "median 5 µs, p99.9 50 µs" to "median 1 µs, p99.9 2 µs". In a business graded on the worst case (Ch. 43 §43.2), a 25× tail improvement dominates a 4× mean improvement.

### Why it works, mechanically

Three things must be true for user space to touch a NIC safely:

1. **The device's registers must be mapped into the process** — an `mmap` of a PCI BAR, so the doorbell write is a plain store to a `volatile` pointer rather than a syscall.
2. **The packet buffers must be at known bus addresses** — the NIC DMAs to physical (or IOVA) addresses, so buffers must be pinned and their translations known. Hence huge pages (§47.3) and memory registration (§47.14).
3. **Isolation must come from somewhere else** — the kernel normally enforces "this process may only send from its own addresses". Bypass replaces that with either an IOMMU (per-device address space), NIC-enforced filtering (Solarflare's per-VI filters), or SR-IOV virtual functions, or it simply grants the process near-raw device access and trusts it.

### The bill

| Cost | Detail |
|---|---|
| **A core is gone** | Poll-mode drivers spin at 100%. One core per polled queue, permanently, whether or not traffic exists. Power, heat, and licence/CPU budget. |
| **You lose the kernel's stack** | ARP, ICMP, routing, TCP, fragmentation, DHCP, multicast IGMP — all become your problem or your vendor's. |
| **You lose the kernel's tooling** | `tcpdump`, `ss`, `netstat`, `ethtool -S` counters, `nstat`, firewalling, and every drop counter of Ch. 46 §46.16 go dark for bypassed traffic. You must build equivalents. |
| **Hardware lock-in** | ef_vi is Solarflare/AMD-only; VMA and RDMA verbs are effectively NVIDIA/Mellanox; DPDK is portable but per-driver in practice. |
| **Deployment complexity** | Huge pages, hugetlbfs, `vfio-pci` binding, `RLIMIT_MEMLOCK`, driver/firmware version matching, IOMMU mode, NUMA placement. Every one is a way to fail at 3am. |
| **A whole class of new bugs** | Descriptor ownership violations, buffer reuse before completion, ring exhaustion, silent hardware drops with no counter you know how to read. |
| **Debuggability** | A crash mid-flight can leave the NIC DMAing into a dead process's memory; recovery paths are genuinely hard. |

**The framing that scores well:** kernel bypass is not "faster networking", it is *moving the network stack into your process and inheriting its operational responsibilities*. Choose it when the tail latency is genuinely worth an engineering team, and choose the cheapest tier that meets the target — often `LD_PRELOAD` Onload rather than a DPDK rewrite.

---

## 47.2 DPDK Poll-Mode Drivers

**DPDK** (Data Plane Development Kit) is a BSD-licensed user-space packet-processing framework: poll-mode drivers for most NICs, a huge-page memory manager, lock-free rings, and a large library ecosystem. It is the general-purpose, vendor-neutral bypass option, and it originated in telecom/NFV rather than trading — which shapes its design toward *throughput*.

### Architecture

```
  ┌──────────── user process (EAL: Environment Abstraction Layer) ────────────┐
  │  lcore 0 (pinned)          lcore 1 (pinned)                              │
  │   while (1) {               while (1) {                                  │
  │     n = rte_eth_rx_burst(     ...                                        │
  │           port, q0,                                                      │
  │           mbufs, 32);                                                    │
  │     process(mbufs, n);                                                   │
  │     rte_eth_tx_burst(...);                                               │
  │   }                                                                      │
  │  rte_mempool of rte_mbuf  ←── huge pages, pinned, IOVA-known              │
  └────────────────┬─────────────────────────────────────────────────────────┘
                   │ mmap'd BARs + DMA to pinned pages
            ┌──────┴──────┐
            │  NIC (bound │  vfio-pci or uio_pci_generic — the kernel driver
            │  to vfio)   │  is DETACHED; the interface disappears from `ip link`
            └─────────────┘
```

`rte_eth_rx_burst()` reads the descriptor ring's DD bits directly and returns up to `n` `rte_mbuf` pointers. It is **not a syscall**; it is a function call that reads a cache line and, occasionally, writes a doorbell.

### `rte_mbuf` versus `sk_buff` — the design contrast

| | `sk_buff` (Ch. 46 §46.7) | `rte_mbuf` |
|---|---|---|
| Size | ~232 B metadata + separate data buffer + `skb_shared_info` | **128 B header, immediately followed by headroom + data in the same 2 KB element** |
| Allocations per packet | 2 (slab + page frag) | **0** — taken from a preallocated per-lcore-cached mempool |
| Cache lines touched (metadata) | 8–15 across the stack | 1–2 |
| Lifetime | Refcounted, cloneable, freed by many paths | Explicit `rte_pktmbuf_free`, refcount for fan-out |
| Chaining | `frags[]` + `frag_list` | `next` pointer, segmented mbufs |

That single design difference — one allocation-free, cache-line-dense structure versus two allocations and a scattered metadata layout — accounts for a large fraction of the performance gap. **`rte_mempool`'s per-lcore cache** means allocation is a pop from a core-local array: no lock, no atomic, ~5 ns.

### Burst-oriented API

Everything in DPDK is a burst: `rx_burst`, `tx_burst`, `rte_mempool_get_bulk`. The rationale is amortising the doorbell write and enabling prefetch pipelining:

```c
n = rte_eth_rx_burst(port, q, bufs, BURST);
for (i = 0; i < n; i++)
    rte_prefetch0(rte_pktmbuf_mtod(bufs[i], void*));   // prefetch payload for i
for (i = 0; i < n; i++)
    handle(bufs[i]);                                    // by now it's in L1
```

**This is also DPDK's latency weakness for trading.** Bursting is a throughput optimisation; a feed handler receiving one critical packet gains nothing from a burst API and pays for the generality. DPDK's *minimum* one-packet latency is competitive (~1 µs) but its design centre is 100+ Mpps forwarding, and ef_vi/TCPDirect are meaningfully leaner for the one-packet case (§47.5, §47.6).

### Operational realities

- **The NIC leaves the kernel.** `dpdk-devbind.py --bind=vfio-pci 0000:03:00.0` detaches the kernel driver; the interface vanishes from `ip link`, `ethtool`, and `tcpdump`. There is no going back without unbinding. Use a *separate* NIC/port from your management interface or you will lock yourself out — a rite of passage.
- **`vfio-pci` versus `uio_pci_generic`**: `vfio` uses the IOMMU for real DMA isolation and is the correct choice; `uio` grants unprotected DMA and requires `iommu=off` or `enable_unsafe_noiommu_mode`. Saying "vfio-pci with the IOMMU enabled" signals you have thought about the safety story.
- **KNI / `virtio-user` / `AF_XDP` PMD** are the escape hatches for injecting exception traffic (ARP, ICMP, management) back into the kernel.
- **The `rte_flow` API** programs hardware flow steering (Ch. 46 §46.14) from the application — including inner-header matching and hardware drop rules.

---

## 47.3 DPDK Huge-Page Memory

DPDK requires huge pages, and the reason is not primarily TLB pressure (though that matters) — it is **physical contiguity and stable IOVA translation**.

### The three reasons

1. **DMA needs I/O addresses.** The NIC DMAs to a bus address. Under `vfio` with an IOMMU, DPDK programs IOVA→physical mappings; without an IOMMU, it must use physical addresses directly. A 4 KB-page-backed buffer is physically scattered, so a 2 KB mbuf could straddle a page boundary into a discontiguous physical frame. A 1 GB huge page is one physically contiguous block: every mbuf inside it is trivially contiguous and its physical address is `base_phys + offset`.

2. **Pages must be pinned.** DMA to a page the kernel might swap or migrate is catastrophic. Huge pages from `hugetlbfs` are inherently unmovable and unswappable (Ch. 32 §32.10).

3. **TLB coverage.** A 4 KB-page TLB with ~1500 entries covers ~6 MB. A packet workload with 2 GB of mbuf pool would miss constantly, and each miss is a page walk (Ch. 32 §32.8). With 1 GB pages, a handful of TLB entries cover the entire pool — **the dTLB miss rate on the packet path drops essentially to zero**, worth 50–150 ns per packet on a large pool.

```bash
# Boot-time (required for 1 GB pages; they cannot be allocated reliably later)
default_hugepagesz=1G hugepagesz=1G hugepages=8
# or 2 MB at runtime (fragmentation-prone after uptime)
echo 2048 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
mount -t hugetlbfs nodev /mnt/huge

# NUMA-aware: allocate on the node the NIC is attached to (Ch. 46 §46.15)
echo 4 > /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages
```

### Traps with diagnostic signatures

- **1 GB pages must be reserved on the kernel command line.** After boot, physical memory is fragmented and the allocation silently gets fewer pages than requested. Signature: EAL init fails with "Cannot get hugepage information" or allocates from the wrong node.
- **NUMA misplacement.** `--socket-mem 4096,0` restricts allocation per socket. Pool memory on node 1 with a NIC on node 0 costs an interconnect hop per packet (Ch. 29 §29.19) — a consistent 100–300 ns you will never find by reading application code. Verify with `dpdk-proc-info` or `numastat`.
- **`RLIMIT_MEMLOCK`** must be raised (or unlimited) for `vfio` DMA mapping. Signature: `VFIO_IOMMU_MAP_DMA` failing with `ENOMEM` despite free memory.
- **Transparent huge pages are irrelevant here** and should generally be off (Ch. 35 §35.19) — DPDK uses explicit hugetlbfs, and THP's compaction is a jitter source for everything else on the box.
- **Leftover files in `/mnt/huge` after a crash** hold the pages; the next start fails or gets less memory. Cleanup is part of the deployment story.

**The general principle**, which recurs in RDMA (§47.14): any DMA-capable user-space networking requires memory that is *pinned, physically stable, and whose device-visible address the application knows*. Huge pages are how DPDK satisfies all three at once.

---

## 47.4 OpenOnload

**Onload** (Solarflare, now AMD) is the highest-leverage bypass technology for trading, because it is **a full user-space TCP/UDP/IP stack that intercepts the standard socket API** — you get bypass without changing a line of code.

```bash
onload --profile=latency ./my_trading_app
# or: EF_POLL_USEC=100000 LD_PRELOAD=libonload.so ./my_trading_app
```

`libonload.so` is `LD_PRELOAD`ed and interposes `socket`, `bind`, `connect`, `send`, `recv`, `epoll_wait`, `select`, and friends. Sockets on an accelerated Solarflare interface are handled entirely in user space; sockets on any other interface fall through to the real syscalls transparently.

### Architecture

```
  application  →  socket()/recv()/epoll_wait()
                        │
              ┌─────────┴───────────┐
              │  libonload (interposer)                             │
              │   ├── accelerated fd? → user-space TCP/UDP/IP stack │
              │   │                     over ef_vi (§47.5)          │
              │   └── otherwise      → real syscall to the kernel    │
              └─────────┬───────────┘
                        │  ef_vi: mmap'd VI (virtual interface): RX/TX
                        │  descriptor rings + event queue + doorbell
                   Solarflare NIC — enforces per-VI filters in hardware
```

The NIC provides many **virtual interfaces (VIs)**, each with its own rings and its own hardware filter table. The kernel driver creates a VI, installs filters (this 4-tuple, this multicast group), and maps the rings into the process. The NIC then delivers matching packets *only* to that process's ring. **That hardware filtering is what makes Onload safe without an IOMMU**: a process cannot receive traffic it did not legitimately bind, because the NIC will not steer it there.

### Why it is the pragmatic favourite

| | Onload | DPDK |
|---|---|---|
| Code change | **None** (`LD_PRELOAD`) | Full rewrite to a burst PMD API |
| TCP | Full user-space TCP with congestion control | You supply it (§47.10) |
| Kernel tooling | `onload_stackdump` (rich), and non-accelerated traffic still normal | Nothing |
| Fallback | Automatic, per socket | None |
| Typical UDP RX latency | ~1.2–2 µs | ~0.8–1.5 µs |
| Vendor | Solarflare/AMD only | Broad |

For a firm with an existing socket-based codebase, Onload converts a multi-quarter rewrite into a launcher change. That is why it is ubiquitous in trading.

### Configuration and traps

- **`EF_POLL_USEC`** — how long a blocking call spins in user space before falling back to the kernel's blocking path. Set high (e.g. 100000) for latency; this is what makes Onload busy-poll. `EF_INT_DRIVEN=0` for pure spinning.
- **`EF_PREFAULT_PACKETS`, `EF_MAX_PACKETS`** — preallocate and pre-touch the packet buffer pool so no page fault ever occurs on the hot path (Ch. 32 §32.16).
- **`EF_TCP_FASTSTART`, `EF_RXQ_SIZE`, `EF_UDP_RECV_SPIN`, `EF_EPOLL_SPIN`** — the per-behaviour spin knobs. `--profile=latency` sets a coherent bundle; start there.
- **Stack sharing**: by default, sockets in one process share an Onload "stack" protected by a lock. Multiple threads hammering one stack contend. `EF_STACK_PER_THREAD` or explicit stack naming (`EF_NAME`) is the fix; the symptom is unexpectedly poor scaling with threads.
- **Silent non-acceleration** is the classic failure: a socket bound to a non-Solarflare interface, or a feature Onload does not accelerate (raw sockets, some `setsockopt` combinations, `SO_TIMESTAMPING` modes), quietly falls back to the kernel. Your latency is kernel latency and nothing in your code says so. **Diagnostic: `onload_stackdump lots` and check the accelerated socket count; `EF_LOG=all` or `onload -v` logs fallbacks.** Verifying acceleration rather than assuming it is the single most valuable operational habit here.
- **`onload_stackdump`** gives per-stack packet counters, ring occupancy, and drop counts — the replacement for `ethtool -S` and `nstat` in a bypassed world.

---

## 47.5 `ef_vi`

**`ef_vi`** is Solarflare's low-level layer — the raw VI interface that Onload itself is built on. You get the descriptor rings and the event queue; you get *no* protocol stack. It is what you use when you want the absolute minimum and are willing to write the packet handling yourself.

```c
ef_driver_open(&dh);
ef_pd_alloc(&pd, dh, ifindex, EF_PD_DEFAULT);
ef_vi_alloc_from_pd(&vi, dh, &pd, dh, -1, -1, -1, NULL, -1, EF_VI_FLAGS_DEFAULT);
ef_memreg_alloc(&mr, dh, &pd, dh, buf, buf_len);      // register DMA memory
ef_vi_receive_init(&vi, dma_addr, /*dma_id=*/i);      // post an RX buffer
ef_vi_receive_push(&vi);                               // doorbell

for (;;) {                                             // the hot loop
    ef_event evs[16];
    int n = ef_eventq_poll(&vi, evs, 16);              // reads an event-queue cache line
    for (int i = 0; i < n; ++i) {
        if (EF_EVENT_TYPE(evs[i]) == EF_EVENT_TYPE_RX) {
            int id  = EF_EVENT_RX_RQ_ID(evs[i]);
            int len = EF_EVENT_RX_BYTES(evs[i]);
            handle(buffer_for(id), len);               // raw Ethernet frame
            ef_vi_receive_init(&vi, dma_addr_for(id), id);   // repost
        }
    }
    ef_vi_receive_push(&vi);
}
```

### The event queue — the key mechanism

Rather than the application scanning descriptor DD bits, the NIC writes **event descriptors into a separate event queue** in host memory. `ef_eventq_poll` reads the next event-queue cache line and checks a phase bit. A single 64-byte cache line read, with no PCIe read and no syscall, is the entire "is there a packet?" check — **~20–40 ns when idle**. This is the tightest possible poll and is why ef_vi's floor is around 700–900 ns wire-to-application.

The same design appears in RDMA completion queues (§47.15) and `io_uring`'s CQ ring (Ch. 34 §34.20): a device- or kernel-written array in shared memory with a phase/generation bit, polled without any transition. Recognising it as one recurring pattern is a strong conceptual answer.

### Where it sits

| | Onload | ef_vi | TCPDirect |
|---|---|---|---|
| API | POSIX sockets | Raw frames, event queue | Small socket-like TCP/UDP API |
| Protocol | Full TCP/UDP/IP | **None — you parse Ethernet/IP/UDP yourself** | Minimal TCP + UDP |
| Latency (UDP RX) | ~1.2–2 µs | ~0.7–1.0 µs | ~0.8–1.2 µs |
| Effort | Zero | High | Moderate |
| Use | Whole application | Market-data receive fast path | Order entry |

The idiomatic trading design is **hybrid**: ef_vi for the market-data receive path (where you only need to parse UDP multicast and every nanosecond counts), and Onload or TCPDirect for order entry (where you need real TCP), with the kernel handling everything else.

### Specific capabilities worth naming

- **Cut-through / `EF_VI_RX_EVENT_MERGE` and "CTPIO"**: CTPIO (Cut-Through Programmed I/O) writes the frame *directly into the NIC's transmit FIFO via PIO stores* rather than via DMA. The NIC begins transmitting before the whole frame has arrived, removing the DMA round trip from the transmit path. Sub-100 ns TX initiation; it is the single biggest ef_vi transmit feature and the mechanism behind sub-microsecond tick-to-trade on non-FPGA hardware. Cost: it consumes PCIe bandwidth inefficiently and only works for small frames.
- **Hardware timestamps** delivered inline in the RX event (`EF_EVENT_RX_TIMESTAMP`), in PHC time (Ch. 45 §45.9).
- **`ef_vi` filters** installed via `ef_filter_spec` — the same NIC hardware filter table Onload uses.

---

## 47.6 TCPDirect

**TCPDirect** (`zf`, "zockets") is Solarflare's middle tier: a user-space TCP and UDP implementation with a *deliberately small, non-POSIX* API, built directly on the VI hardware without Onload's socket-compatibility layer.

```c
struct zf_stack* stack; struct zf_attr* attr;
zf_init(); zf_attr_alloc(&attr); zf_stack_alloc(attr, &stack);

struct zft_handle* h; struct zft* z;
zft_alloc(stack, attr, &h);
zft_addr_bind(h, local, 0); zft_connect(h, remote, &z);

for (;;) {
    zf_reactor_perform(stack);            // poll the NIC; drives the whole stack
    struct { struct zft_msg m; struct iovec iov[2]; } rd = { .m = {.iovcnt = 2} };
    zft_zc_recv(z, &rd.m, 0);             // ZERO-COPY receive: iov points INTO the ring
    if (rd.m.iovcnt) { parse(rd.iov[0].iov_base, rd.iov[0].iov_len);
                       zft_zc_recv_done(z, &rd.m); }   // return ownership
}
```

### Why it exists

Onload must be bug-compatible with POSIX sockets: byte-stream buffering, `errno`, blocking semantics, `epoll`, `fcntl`, fork safety. That compatibility costs both code path and a copy — `recv()` must copy into *your* buffer because POSIX says so.

TCPDirect throws it away. `zft_zc_recv` hands you an `iovec` pointing **directly at the packet buffer in the receive ring**. You parse in place and call `zft_zc_recv_done` to release it. No copy at all, and the ownership protocol is explicit (Ch. 45 §45.17).

| | Onload | TCPDirect |
|---|---|---|
| API | POSIX sockets, drop-in | Bespoke `zf*` API, requires a rewrite |
| Receive | Copy into the user buffer | **Zero-copy `iovec` into the ring** |
| Threading | Multi-threaded, locked stack | Single-threaded per stack by design; you call `zf_reactor_perform` |
| Blocking | Supported | Essentially none — you poll |
| Feature set | Full TCP | TCP subset: no fragmentation, limited options, restricted socket options |
| Latency (TCP RX) | ~1.5–2.5 µs | **~0.8–1.2 µs** |

### Trade-offs and traps

- **The receive buffer belongs to the ring.** Holding an `iovec` across many packets starves the ring of free buffers; the diagnostic signature is receive drops under load that vanish when you copy-and-release immediately. The discipline is: parse in place, extract exactly the fields you need into your own structures, release.
- **`zf_reactor_perform` must be called continuously.** It is the pump for everything — receive, TCP timers, retransmission, ACKs. A thread that stops calling it stalls the connection, and TCP will time out. This is a real hazard in a design where the same thread also does strategy work: a long strategy computation delays ACKs and retransmits.
- **A `zf_stack` is single-threaded.** Sharing one across threads without external serialisation is undefined. One stack per thread, one thread per core.
- **Feature gaps bite at integration time.** No IP fragmentation, limited `setsockopt` equivalents, restricted TCP option support. You discover this against a specific exchange's gateway, late.

**Positioning it correctly in an interview**: Onload = zero effort, good latency; TCPDirect = a rewrite, best non-FPGA TCP latency, zero-copy, and you take on the reactor discipline; ef_vi = maximum control, no protocol at all. The right answer names the tier that fits the constraint, not the fastest one.

---

## 47.7 VMA

**VMA** (Voltaire/Mellanox Messaging Accelerator, now largely superseded by **XLIO**, the eXtreme Low-latency IO library) is NVIDIA/Mellanox's answer to Onload: an `LD_PRELOAD` user-space stack over Mellanox NICs' RDMA-capable verbs interface.

```bash
LD_PRELOAD=libvma.so VMA_SPEC=latency ./my_app
# XLIO (the modern replacement):
LD_PRELOAD=libxlio.so XLIO_SPEC=latency ./my_app
```

### Mechanism

VMA builds on the **verbs** layer (§47.15) rather than on a proprietary VI API: it allocates a raw-Ethernet queue pair, registers memory regions, installs flow steering rules, and polls a completion queue. The user-space TCP/UDP/IP stack sits on top of that.

```
socket API  →  libvma  →  user-space UDP/TCP/IP  →  ibverbs raw-Ethernet QP
                                                     → mlx5 NIC (flow steering rules)
```

That layering is the notable architectural point: **VMA/XLIO reuse the RDMA software stack for plain Ethernet**, which is why an "RDMA" driver stack (`rdma-core`, `libibverbs`, `libmlx5`) is a prerequisite for a pure TCP/UDP accelerator.

### Comparison

| | Onload (Solarflare/AMD) | VMA / XLIO (NVIDIA/Mellanox) |
|---|---|---|
| Underlying interface | Proprietary VI / ef_vi | ibverbs raw-Ethernet QP |
| API interception | `LD_PRELOAD` | `LD_PRELOAD` |
| Multicast receive | Excellent; hardware filters per VI | Good; flow steering rules |
| TCP maturity | Very mature, long trading track record | Historically weaker; XLIO improved it |
| Typical UDP RX | ~1.2–2 µs | ~1.5–2.5 µs |
| Ecosystem | `onload_stackdump` | `vma_stats`, `ibv_devinfo`, `rdma` tooling |

Both share the same failure mode and the same discipline: **silent fallback**. `VMA_TRACELEVEL=3` / `vma_stats -p <pid>` shows which sockets are offloaded. A socket that VMA declines to accelerate — wrong interface, unsupported option, too many sockets for the configured resources — runs at kernel speed with no error.

**Configuration highlights:** `VMA_SPEC=latency` (aggressive spinning), `VMA_RX_POLL=-1` (spin forever), `VMA_SELECT_POLL`, `VMA_THREAD_MODE` (single-threaded mode removes internal locking), `VMA_MEM_ALLOC_TYPE` (huge pages). The parallels to Onload's `EF_*` knobs are exact, which makes the two easy to discuss side by side.

The honest assessment for interviews: **VMA/XLIO is the Mellanox-shop equivalent of Onload; it is chosen by hardware vendor rather than on merit, and Solarflare + Onload has historically had the stronger reputation specifically for trading UDP multicast and TCP order entry.** Mellanox's strength is RDMA and 100/200/400G throughput.

---

## 47.8 AF_XDP and XDP

Kernel-community bypass: keep the kernel driver and the kernel's operational model, but let the application take packets before the stack.

### XDP

**XDP** (eXpress Data Path) runs a verified eBPF program **in the driver, on the raw DMA'd frame, before any `sk_buff` is allocated.** This is the earliest software hook in Linux.

```c
SEC("xdp") int filter(struct xdp_md* ctx) {
    void* data = (void*)(long)ctx->data, *end = (void*)(long)ctx->data_end;
    struct ethhdr* eth = data;
    if ((void*)(eth + 1) > end) return XDP_PASS;      // bounds check — the verifier demands it
    if (eth->h_proto != bpf_htons(ETH_P_IP)) return XDP_PASS;
    /* ... */
    return bpf_redirect_map(&xsks_map, ctx->rx_queue_index, 0);   // → AF_XDP socket
}
```

Return codes: `XDP_PASS` (into the normal stack), `XDP_DROP` (free immediately — the cheapest possible drop, ~10–20 ns, used for DDoS mitigation at tens of Mpps per core), `XDP_TX` (bounce back out the same NIC — the basis of user-programmable L2 forwarding and of ultra-fast in-kernel responders), `XDP_REDIRECT` (to another device or to an AF_XDP socket), `XDP_ABORTED`.

Three modes: **native** (in the driver, the real thing), **offloaded** (on a SmartNIC's cores, Ch. 48 §48.3), and **generic** (after skb allocation — a compatibility fallback with none of the performance and a trap for benchmarkers who forget to check `ip link` for `xdpgeneric`).

### AF_XDP

**AF_XDP** is a socket type that receives frames redirected by XDP into a user-space memory region called a **UMEM**, via four single-producer/single-consumer rings in shared memory:

```
UMEM: a user-allocated, registered chunk of memory divided into fixed frames

  FILL ring   (user → kernel): "these frames are empty, put packets in them"
  RX ring     (kernel → user): "packet in frame at offset X, length L"
  TX ring     (user → kernel): "transmit the frame at offset X, length L"
  COMPLETION  (kernel → user): "this TX frame is free again"
```

That four-ring structure — two for RX with buffer recycling, two for TX with completion — is the canonical zero-copy DMA interface and reappears in `io_uring` and in RDMA. **The FILL ring is the thing people forget**: if you do not keep it populated, the driver has no buffers, and packets are dropped with no obvious counter. Symptom: receive stalls at a fixed number of packets — exactly the size of your initial fill.

`XDP_ZEROCOPY` mode makes the driver DMA straight into UMEM frames (true zero-copy, driver support required); `XDP_COPY` is the fallback and copies once. Check which you got — the `bind` succeeds either way.

### Where it sits

| | AF_XDP | DPDK |
|---|---|---|
| Kernel driver | **Retained** — `ethtool`, `ip link`, counters still work | Detached |
| Per-queue selectivity | Yes — bypass queue 3, leave 0–2 in the kernel | All or nothing (per port/VF) |
| Latency | ~1.5–3 µs | ~0.8–1.5 µs |
| Throughput | ~20–30 Mpps/core | ~50–100+ Mpps/core |
| Portability | Any driver with XDP support; generic mode anywhere | Per-PMD |
| Root/caps | `CAP_NET_ADMIN`/`CAP_BPF` | `vfio` device access |

**The trading verdict:** AF_XDP is the best *operational* story — you keep the kernel, keep the tooling, and bypass only the queue you care about — but it is not as fast as ef_vi or DPDK, because the frame still passes through the driver's XDP hook and the ring handoff. It is the right choice when you need bypass-class throughput with kernel-class operability, and a good "what would you use if you could not buy Solarflare" answer.

---

## 47.9 `PACKET_MMAP` and `AF_PACKET`

The oldest raw-packet interface in Linux, and the foundation of `libpcap`/`tcpdump` (Ch. 48 §48.7). Not bypass — the kernel is fully in the path — but it removes the *copy* and, with `TPACKET_V3`, most of the syscalls.

```c
int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
setsockopt(fd, SOL_PACKET, PACKET_VERSION, &v3, sizeof v3);
setsockopt(fd, SOL_PACKET, PACKET_RX_RING, &req, sizeof req);
void* ring = mmap(NULL, sz, PROT_READ|PROT_WRITE, MAP_SHARED|MAP_LOCKED, fd, 0);
// then poll the ring's per-block/per-frame status word — no syscall while data flows
```

The kernel copies each frame into a slot in an `mmap`ed ring and sets a status word; user space reads it directly and resets the status when done. This is the same shared-ring pattern again.

| Version | Structure | Note |
|---|---|---|
| `TPACKET_V1/V2` | Fixed-size frames, one status word each | Simple; wastes space on small packets |
| **`TPACKET_V3`** | Variable-length frames packed into **blocks**, one status word per block, with a block timeout | Far better memory efficiency and fewer status-word cache lines; the version to use |

### What it is and is not

- **It is not bypass.** The packet still traverses the driver, NAPI, and skb allocation (Ch. 46 §46.7); `AF_PACKET` taps it at `netif_receive_skb` (or, with `PACKET_FANOUT`, after). The saving is `copy_to_user` and the per-packet syscall, not the stack.
- **`PACKET_FANOUT`** load-balances a capture across multiple `AF_PACKET` sockets by hash, round-robin, CPU, or a BPF program — the capture-side equivalent of `SO_REUSEPORT` (Ch. 45 §45.6), and how high-rate capture scales across cores.
- **`PACKET_TX_RING`** does the same for transmit — write frames into the ring and one syscall sends them all. Useful for a replay/injection tool.
- **`PACKET_QDISC_BYPASS`** skips the qdisc layer (Ch. 46 §46.2) on transmit.
- **`PACKET_TIMESTAMP` with `SOF_TIMESTAMPING_RAW_HARDWARE`** puts hardware timestamps in the ring metadata — this is how you build a hardware-timestamped capture without a dedicated capture card.
- **The frame is a *copy*, so the packet still reaches the normal stack too.** `AF_PACKET` is a tap, not a diversion (unlike XDP redirect). That is what makes it safe for capture and useless for bypass.

**Where it belongs in a trading system:** the capture and compliance path, not the trading path. A `TPACKET_V3` + `PACKET_FANOUT` + hardware-timestamp capture process, on housekeeping cores, recording everything for post-trade analysis (Ch. 48 §48.8) and deterministic replay (Ch. 53 §53.9). Knowing that `tcpdump` uses exactly this, and that running it perturbs the hot path by forcing skb clones (Ch. 46 §46.7), closes the loop.

---

## 47.10 User-Space TCP/IP Stacks

Once you bypass the kernel you no longer have TCP, and TCP is genuinely hard. The options:

| Stack | Origin | Character |
|---|---|---|
| **Onload / TCPDirect** | Solarflare/AMD | Production-grade, exchange-tested, commercially supported |
| **VMA / XLIO** | NVIDIA | Same role on Mellanox |
| **mTCP** | Academic (KAIST) | Per-core stacks over DPDK; research quality |
| **F-Stack** | Tencent | FreeBSD's stack ported onto DPDK — mature TCP, heavyweight |
| **Seastar** (`native` mode) | ScyllaDB | Shard-per-core futures framework with its own DPDK TCP |
| **lwIP** | Embedded | Small, not fast |
| **In-house** | Many HFT firms | Minimal TCP: no fragmentation, fixed window, simplified retransmit |

### Why in-house minimal TCP is a real strategy

An exchange order-entry session is a *single, long-lived, low-rate, colocated* connection over a lossless-ish LAN. The general-purpose requirements TCP carries — congestion control across the internet, path MTU discovery, window scaling across a 200 ms RTT, SACK, delayed ACKs, Nagle — are all irrelevant or harmful (Ch. 38). A stack that implements:

- the three-way handshake and teardown,
- sequence/ACK tracking with a fixed, generous window,
- retransmission on a short fixed timer with no congestion backoff,
- immediate ACKs, no Nagle,
- and *nothing else*,

is a few thousand lines, has a deterministic hot path with no timers firing unexpectedly, and can be significantly faster than a full stack. The trade is enormous: correctness under loss, exchange interoperability quirks, and the fact that TCP bugs manifest as silently corrupted or duplicated *orders* (Ch. 54 §54.9).

### The specific hard parts

1. **Timers.** TCP needs retransmission, delayed-ACK, keepalive, and TIME_WAIT timers. In a poll-loop architecture these must be driven from your reactor (as TCPDirect's `zf_reactor_perform` does, §47.6), which means **a strategy computation that blocks the loop delays ACKs and triggers spurious retransmissions on the peer.** This coupling between application compute time and TCP correctness is the number-one surprise for teams building their own.
2. **Retransmission requires buffer retention.** Sent data must be held until ACKed — the ownership problem of Ch. 45 §45.17 again, and the reason zero-copy transmit and TCP interact badly.
3. **Connection state on crash.** The kernel cleans up sockets on process death; a user-space stack leaves the peer with a half-open connection and the NIC potentially still DMAing. Recovery and fencing (Ch. 56 §56.5) become application concerns.
4. **No `SO_*` semantics.** Every socket option your code relies on must be reimplemented or dropped.

**The interview answer:** buy TCP (Onload/TCPDirect), build UDP. Market data is UDP multicast — a receive-only, stateless, single-direction path that is genuinely simple to implement over ef_vi in a few hundred lines. TCP is where the correctness risk lives, and where a vendor's decade of exchange interop testing is worth more than the last 300 nanoseconds.

---

## 47.11 Busy-Poll NIC Loops

Every bypass architecture converges on the same structure: **one thread, pinned to an isolated core, spinning on a device-written memory location forever.**

```cpp
// Canonical bypass hot loop. Note what is ABSENT: syscalls, allocation,
// locks, branches on rare conditions, and any call that can block.
void run(Vi& vi, Book& book, Gateway& gw) {
    for (;;) {
        Event evs[16];
        int n = vi.poll(evs, 16);              // one cache-line read when idle
        if (n == 0) { cpu_relax(); continue; } // PAUSE: ~20-40 cycles, yields SMT resources
        for (int i = 0; i < n; ++i) {
            const Frame f = vi.frame(evs[i]);
            if (auto* upd = parse_udp_itch(f))    // in place, no copy (Ch. 51 §51.9)
                if (auto sig = book.apply(*upd))  // preallocated, branch-light
                    gw.send_order(sig);           // descriptor + doorbell, ~200 ns
            vi.repost(evs[i]);                    // return the buffer to the ring
        }
    }
}
```

### Why spinning is not merely "wasting a core"

- **It keeps the core in C0.** No C-state exit (Ch. 46 §46.4) — this alone removes a 30–60 µs tail event.
- **It keeps caches and TLBs warm.** The loop's code, the ring, the book, and the gateway's descriptors stay resident. A thread that sleeps loses its L1/L2 to whatever ran meanwhile — measurably hundreds of nanoseconds on wake (Ch. 28 §28.10).
- **It keeps the branch predictors and the frequency high.** A core that idles drops frequency; turbo ramp is tens of microseconds (Ch. 35 §35.12).
- **It removes the scheduler from the data path entirely** — the single largest source of tail latency.

The cost is not really the core; it is **thermal and frequency coupling with neighbours** (a spinning core generates heat that can limit turbo on the package) and the operational reality of 100% CPU graphs that alarm monitoring systems.

### Loop hygiene — what interviewers probe

| Concern | Practice |
|---|---|
| SMT sibling | Disable hyperthreading on the core, or leave the sibling idle. A busy sibling halves your front-end bandwidth (Ch. 27 §27.17). |
| `PAUSE` / `cpu_relax` | Use it in the empty branch: reduces power, avoids memory-order-violation machine clears, and yields pipeline resources to the SMT sibling. On Skylake+ `PAUSE` is ~140 cycles; on older parts ~10 — check before assuming. |
| Isolation | `isolcpus`, `nohz_full`, `rcu_nocbs`, `irqaffinity` elsewhere, `irqbalance` off (Ch. 46 §46.15). |
| Scheduling | `SCHED_FIFO` so nothing preempts you — but **never `SCHED_FIFO` with a bug that spins without yielding on a non-isolated core**, or you lock up the machine (`sched_rt_runtime_us` is the safety valve, Ch. 31 §31.21). |
| Memory | Everything preallocated and pre-faulted; `mlockall(MCL_CURRENT|MCL_FUTURE)`; huge pages (Ch. 32 §32.16). A single page fault on the hot path is ~1–3 µs. |
| Branch layout | The "no packet" case is by far the most common; lay the code out so the *packet* case is the fall-through if that is where latency matters, and use PGO/BOLT (Ch. 40 §40.9, §40.11). |
| Warmup | Run synthetic packets through the entire path at startup so every branch predictor entry, every cache line, and every page is warm (Ch. 60 §60.7). Cold-path first-message latency can be 10× the steady state. |
| Bounded work | Never allocate, never log to disk, never take a lock, never call anything that can block. Logging goes to a lock-free ring consumed by another core (Ch. 59 §59.6). |

**The "duty cycle" subtlety:** a loop that receives a packet every 10 µs spends most of its time in the empty branch. The *code* executed on a packet is therefore cold-ish in the branch predictors relative to the empty path. Some shops deliberately push synthetic packets through a shadow path to keep the hot path warm — a genuinely advanced technique worth mentioning.

---

## 47.12 Zero-Copy Receive

**Zero-copy receive** means the application reads the packet bytes from the exact memory the NIC DMA'd them into — no `copy_to_user`, no intermediate buffer.

```
Kernel path:  NIC ─DMA→ skb page ─copy_to_user→ app buffer ─read→ CPU registers
                                     ^^^^^^^^^ 60–100 ns/1500 B + cache pollution

Bypass:       NIC ─DMA→ registered buffer in the ring ─read→ CPU registers
                        (app parses in place; ownership returned by reposting)
```

### What is actually saved

The copy itself is 60–100 ns for a full frame — real but not dramatic. The larger effects:

1. **Cache pollution.** A copy reads 24 cache lines and writes 24 more. Under DDIO (Ch. 29 §29.24) the source is already in L3, so the copy pulls it into L1 and evicts a chunk of your order book. Skipping it means the *only* lines you touch are the ones you actually parse — often just the first 64 bytes of the packet.
2. **Dependent-load latency.** Copy-then-parse is two serial passes over the data; parse-in-place is one, so the first field is available ~100+ ns earlier.
3. **No allocation.** Ring buffers are preallocated (Ch. 55 §55.1).

### The ownership cost (the recurring theme)

The buffer belongs to the ring. You must repost it. Three failure modes with distinct signatures:

| Failure | Signature |
|---|---|
| **Holding buffers too long** (parsing into a queue that backs up) | Ring runs out of free buffers → hardware drops with a rising `rx_nodesc_drop`-style counter, and the drops are invisible to any kernel counter |
| **Reposting before you finish reading** | The NIC overwrites the buffer mid-parse → intermittent garbage in *later* fields of a message, load-dependent, unreproducible |
| **Keeping a pointer into the ring past the handler** | Classic use-after-free, but with a *device* as the writer, so ASan/Valgrind see nothing |

The discipline: **parse in place, copy out only the fields you keep, repost immediately.** If a message must be retained (a snapshot, a recovery buffer), copy it into your own arena. Copying 40 bytes of extracted fields is nothing; retaining a 1500-byte ring buffer for milliseconds is a drop generator.

### Zero-copy receive on the kernel path

For completeness, since it comes up: `TCP_ZEROCOPY_RECEIVE` (Linux 4.18+) `mmap`s received pages into the process's address space, avoiding the copy for large, page-aligned TCP receives. Requirements — page-aligned, MTU-aligned payloads, an `mmap`/`munmap` per receive with TLB shootdown cost (Ch. 32 §32.9) — mean it only pays for multi-hundred-KB streams. **It is useless for market data**, and knowing why (TLB shootdown cost per receive exceeds the copy for small messages) is a better answer than knowing it exists.

---

## 47.13 Descriptor Ownership and Completion Queues

The unifying abstraction across ef_vi, DPDK, AF_XDP, `io_uring`, and RDMA:

```
  ┌── application ──┐                     ┌── device / kernel ──┐
  │ produce request │ ── submission ring ─►│ consume, execute     │
  │                 │                      │                     │
  │ consume result  │ ◄─ completion ring ──│ produce completion   │
  └─────────────────┘                     └─────────────────────┘

  Both rings live in shared memory.  Progress is signalled by:
    - a producer/consumer index pair (io_uring, AF_XDP), or
    - a phase/generation bit per entry (ef_vi event queue, RDMA CQ, NVMe)
```

The **phase-bit design is the better one for polling**: instead of reading a producer index written by the device (which requires the device to write a separate cache line, and requires you to read it), each completion entry carries a bit that flips every time the ring wraps. Polling is "read the next entry's cache line; if its phase bit matches the expected generation, it is new". **One cache line read, no PCIe read, no additional synchronisation.** That is why `ef_eventq_poll` is ~20 ns.

### The ownership state machine

```
FREE ──app posts descriptor──► DEVICE-OWNED ──device writes completion──► APP-OWNED
  ▲                                                                          │
  └────────────────── app reposts / frees ───────────────────────────────────┘
```

Rules that must hold, and what happens when they do not:

| Rule | Violation |
|---|---|
| Never read or write a device-owned buffer | Torn or garbage data; on transmit, the wire content differs from what you built |
| Never post a descriptor twice | Two completions for one buffer; a double free in your pool; corruption on the next reuse |
| Never assume completions are in order | RDMA unreliable transports and some multi-queue paths complete out of order; match by work-request ID (`wr_id`), never by position |
| Keep the ring supplied | Ring exhaustion = hardware drops with no software counter |
| Memory barriers around the doorbell | The descriptor stores must be **globally visible before** the doorbell write, or the device reads a stale descriptor |

That last one is the deep detail. The sequence is:

```cpp
desc[tail] = build_descriptor(...);      // normal stores
std::atomic_thread_fence(std::memory_order_release);   // or sfence / dmb ishst
*doorbell = tail + 1;                    // MMIO write-combining store
```

On x86-64 (TSO, Ch. 29 §29.13) stores are not reordered with stores, so a compiler barrier suffices for the descriptor→doorbell ordering — **but the doorbell is typically in a write-combining region**, and WC stores *are* weakly ordered and buffered. An `SFENCE` (or a `_mm_sfence()`/release fence) is required to flush the WC buffer and guarantee the doorbell actually leaves the CPU promptly. On ARM, a full `DMB ISHST` (or `DSB` for device memory) is mandatory. **Ordering bugs here produce a hang: the device never sees the doorbell, the queue silently stops, and there is no error anywhere.** This is exactly the material of Ch. 25 §25.16 applied to a device, and being able to state it is a strong signal.

### Sizing and backpressure

The completion queue *is* the flow-control signal. If it fills before you drain it, the device either stalls or (RDMA) puts the queue pair into an error state. Sizing rules:

- CQ depth ≥ the maximum number of outstanding work requests across all queues feeding it.
- For RDMA, a CQ overrun is **fatal to the QP** — it transitions to `IBV_QPS_ERR` and all subsequent completions are flush errors. Recovering means tearing down and re-establishing, which for a trading session means a reconnect (Ch. 54 §54.10).
- Poll the CQ before posting, always, so that a burst of sends cannot outrun your reaping.

---

## 47.14 Memory Registration and Pinning

Before hardware can DMA to or from user memory, three things must be arranged, and **memory registration** is the operation that does all three.

```c
struct ibv_mr* mr = ibv_reg_mr(pd, buf, len,
        IBV_ACCESS_LOCAL_WRITE | IBV_ACCESS_REMOTE_READ | IBV_ACCESS_REMOTE_WRITE);
// mr->lkey  : local key — cite it in every local work request
// mr->rkey  : remote key — hand to the peer so it may RDMA into this region (§47.17)
```

What `ibv_reg_mr` does:

1. **Pins the pages** (`get_user_pages`, charged against `RLIMIT_MEMLOCK`) so they cannot be swapped, migrated by NUMA balancing (Ch. 32 §32.27), or reclaimed.
2. **Builds the device's translation tables** — an on-NIC MTT/MPT mapping the region's virtual addresses to physical/IOVA addresses, so the NIC can translate a VA in a work request.
3. **Issues keys.** `lkey` authorises local access; `rkey` authorises a *remote* peer's one-sided access to exactly that region with exactly those permissions.

### Why it is expensive and what to do about it

Registration costs **tens to hundreds of microseconds per call**, scaling with region size (pinning is per-page work, plus a device command and MTT population). It is emphatically a setup-time operation.

| Strategy | Notes |
|---|---|
| **Register everything once at startup** | The standard trading answer. One large region for all buffers; carve arenas out of it (Ch. 7 §7.7). |
| **Registration cache** | For dynamic buffers: cache VA-range→MR mappings. Correctness hazard: `munmap`/`fork`/`madvise(MADV_DONTNEED)` can invalidate the mapping under you. Requires an `madvise`/`mmu_notifier` hook. This has produced real, famous corruption bugs (MPI implementations). |
| **ODP (On-Demand Paging)** | Mellanox feature: the NIC page-faults through the kernel instead of requiring pinning. Removes registration cost and the pinning limit; adds an unbounded page-fault latency on first touch — **fatal for a latency path, fine for bulk.** |
| **`IBV_ACCESS_RELAXED_ORDERING`** | Allows PCIe relaxed ordering — a real throughput win on some platforms. |

### Traps with diagnostic signatures

- **`RLIMIT_MEMLOCK`.** Default is often 64 KB. `ibv_reg_mr` returns `ENOMEM` for anything real. Fix in `limits.conf`/systemd `LimitMEMLOCK=infinity`. Signature: registration fails immediately at startup, sometimes only for the second process on the box.
- **`fork()` and registered memory.** COW (Ch. 31 §31.3) can give the *child* the original physical page and the parent a copy — while the NIC still DMAs to the original physical address. The result is DMA into the wrong process's memory, silently. `ibv_fork_init()` (which `madvise(MADV_DONTFORK)`s registered regions) must be called before any registration if the process ever forks. **This is one of the sharpest RDMA gotchas and is worth knowing verbatim.**
- **Huge pages.** Registering a huge-page-backed region produces far fewer MTT entries, so the NIC's translation cache (its own TLB) hits, saving ~100 ns per operation on large regions. The same argument as §47.3.
- **NUMA.** Register memory on the node the HCA is attached to, first-touched by a thread on that node (Ch. 29 §29.18).

**The generalisation to state:** every user-space DMA technology — DPDK mempools, AF_XDP UMEM, ef_vi `ef_memreg`, RDMA MRs, `MSG_ZEROCOPY` page pinning — is solving the identical problem: *make user memory pinned, physically stable, and addressable by the device.* They differ only in the API and in who enforces isolation.

---

## 47.15 RDMA Queue Pairs and Completion Queues

**RDMA** (Remote Direct Memory Access) lets one machine's NIC read or write another machine's memory with **no involvement from the remote CPU** — no interrupt, no syscall, no kernel, no application thread. Define the terms before using them:

| Object | Meaning |
|---|---|
| **HCA / RNIC** | The RDMA-capable adapter |
| **PD** (Protection Domain) | A grouping; MRs and QPs in the same PD may be used together. The isolation boundary. |
| **MR** (Memory Region) | Registered, pinned memory with `lkey`/`rkey` (§47.14) |
| **QP** (Queue Pair) | A **send queue + receive queue**. The unit of connection. Has a QP number (QPN). |
| **CQ** (Completion Queue) | Where completions (`ibv_wc`) land. Multiple QPs may share one. |
| **WR / WQE** | Work Request / Work Queue Entry — the operation you post |
| **SRQ** | Shared Receive Queue — one receive queue serving many QPs, so you do not pre-post N buffers per connection |

```
   Host A                                      Host B
 ┌──────────────────────┐                  ┌──────────────────────┐
 │ app                  │                  │ app  (NOT INVOLVED   │
 │  ibv_post_send(WR) ──┼──► SQ            │       for one-sided) │
 │                      │    │             │                      │
 │  ibv_poll_cq() ◄─────┼─ CQ│             │  MR (rkey, pinned)   │
 └──────────────────────┘    │             └──────────▲───────────┘
                          HCA A ── network ── HCA B ──┘ writes DRAM directly
```

### The data path

```c
ibv_sge     sge = { .addr = (uintptr_t)buf, .length = n, .lkey = mr->lkey };
ibv_send_wr wr  = { .wr_id = my_id, .sg_list = &sge, .num_sge = 1,
                    .opcode = IBV_WR_RDMA_WRITE, .send_flags = IBV_SEND_SIGNALED,
                    .wr = { .rdma = { .remote_addr = peer_addr, .rkey = peer_rkey } } };
ibv_post_send(qp, &wr, &bad);          // user-space: build WQE, ring doorbell. NO SYSCALL.

ibv_wc wc;
while (ibv_poll_cq(cq, 1, &wc) == 0) cpu_relax();    // poll — no syscall, no interrupt
if (wc.status != IBV_WC_SUCCESS) handle_error(wc.status);
```

`ibv_post_send` is a user-space library function that writes a WQE into a mapped queue and rings a doorbell — the same pattern as §47.13. Typical one-way RDMA write latency: **~1–2 µs** over InfiniBand or RoCE, versus ~15 µs for a kernel TCP round trip.

### QP transport types

| Type | Reliable | Connected | Notes |
|---|---|---|---|
| **RC** (Reliable Connected) | Yes — hardware ACKs, retransmission, ordering | One QP per peer | Supports all operations including one-sided RDMA and atomics. **The default choice.** N² QPs at scale. |
| **UC** (Unreliable Connected) | No | Yes | RDMA write allowed, no reliability. Rare. |
| **UD** (Unreliable Datagram) | No | No — one QP talks to many | Like UDP; **no RDMA read/write, only send/recv**, and limited to one MTU per message. Scales to many peers with one QP; used for multicast and discovery. |
| **DC** (Dynamically Connected) | Yes | Dynamic | Mellanox-specific; RC semantics without N² QPs. |

**"One-sided RDMA requires RC (or UC)"** is a frequent exam point: you cannot RDMA-read over UD.

### Completion management

- **`IBV_SEND_SIGNALED`** requests a completion. Unsignalled sends generate none, which saves CQ bandwidth and polling work. Standard practice: signal every Nth send to bound the send queue's outstanding count while still reclaiming WQEs — but **you must signal often enough that the send queue drains, or you overrun it** (`ENOMEM` from `ibv_post_send`).
- **`IBV_SEND_INLINE`** copies a small payload (typically ≤ 64–256 bytes, device-specific) into the WQE itself, so the NIC does not need a second DMA read to fetch the data. **This is a large latency win for small messages — roughly 300–600 ns — and is exactly the regime a trading message lives in.** Knowing `IBV_SEND_INLINE` is a strong differentiator.
- **Polling versus events.** `ibv_poll_cq` in a spin loop is the low-latency mode. The alternative — a completion channel with `ibv_get_cq_event` and a blocking `read` on an fd — reintroduces the interrupt and wakeup you paid to remove (~10 µs), and exists for throughput/efficiency workloads.
- **A CQ overrun or a protection violation puts the QP into `IBV_QPS_ERR`.** All outstanding WRs then complete with `IBV_WC_WR_FLUSH_ERR`, and the QP is dead until reset and re-transitioned through `INIT → RTR → RTS`. The signature — a burst of `WR_FLUSH_ERR` after one real error — is the standard "something failed a while ago, this is the aftermath" pattern, and the *first* non-flush status is the real cause.

---

## 47.16 RDMA Memory Regions

(Registration mechanics are §47.14; this section is the *semantics* of what a region authorises.)

An MR binds four things: a virtual address range, a protection domain, an access-permission set, and a pair of keys.

| Access flag | Grants |
|---|---|
| `IBV_ACCESS_LOCAL_WRITE` | The local HCA may write here — **required for any receive buffer** |
| `IBV_ACCESS_REMOTE_READ` | A peer holding the `rkey` may RDMA-read this region |
| `IBV_ACCESS_REMOTE_WRITE` | A peer may RDMA-write it (implies `LOCAL_WRITE`) |
| `IBV_ACCESS_REMOTE_ATOMIC` | A peer may perform compare-and-swap / fetch-and-add here |
| `IBV_ACCESS_MW_BIND` | Memory windows may be bound to it |
| `IBV_ACCESS_RELAXED_ORDERING` | PCIe relaxed ordering permitted |

### The security model, and why it is thin

The `rkey` is a 32-bit token. **Any peer that possesses your `rkey` and the region's virtual address can read or write that memory at will, with no CPU involvement and no audit trail on your side.** There is no per-operation authorisation, no logging, and no way to notice.

Mitigations and their costs:

| Mitigation | Cost |
|---|---|
| **Register the minimum region** — one small, purpose-built buffer per peer, never the whole heap | More MRs, more registration time, more MTT pressure |
| **Re-register to rotate `rkey`s** | Tens to hundreds of µs per rotation |
| **Memory Windows** (`ibv_alloc_mw` + bind) | A lightweight, fast-to-rebind sub-region of an MR with its own `rkey`. Type 2 MWs bind via a work request on the fast path (~1 µs), so you can grant per-transfer access. The correct tool for dynamic, least-privilege remote access. |
| **Separate PDs per peer** | Prevents cross-use of MRs and QPs |

**This is why RDMA is a datacenter-internal, trusted-fabric technology.** Stating that clearly — "RDMA's protection model is a 32-bit capability token with no revocation and no audit; it is designed for a trusted fabric, which is why you see it inside a firm and never across a venue boundary" — is a genuinely strong answer.

### Practical MR strategy for a trading system

```
One large MR over a pre-registered arena on the NIC's NUMA node, backed by 1 GB huge pages.
  ├── ring of receive buffers   (LOCAL_WRITE)
  ├── send staging area          (LOCAL_WRITE; small messages use SEND_INLINE and skip it)
  └── an explicitly exported window per peer for one-sided writes (REMOTE_WRITE only,
      sized to exactly the shared structure, never overlapping anything else)
```

Registration cost is paid once at startup; the hot path never touches the kernel or the registration API. This mirrors the preallocation discipline of Ch. 55 §55.1 exactly.

---

## 47.17 One-Sided and Two-Sided RDMA

The distinction that defines RDMA's value.

| | **Two-sided** (SEND/RECV) | **One-sided** (RDMA READ / WRITE / ATOMIC) |
|---|---|---|
| Remote CPU | **Involved**: must have pre-posted a receive WQE; gets a completion | **Not involved at all**: no completion, no interrupt, no notification |
| Remote knowledge | The receiver learns a message arrived | The target has *no idea* anything happened |
| Addressing | The receiver chooses the destination buffer | The **initiator** specifies `remote_addr` + `rkey` |
| Setup | Receiver must keep receive WQEs posted (or use an SRQ) | Initiator must have been told the address and `rkey` out of band |
| Failure mode | `IBV_WC_RNR_RETRY_EXC_ERR` if no receive is posted | Protection error, or silent overwrite of the wrong thing |
| Latency | ~1.5–2.5 µs | ~1–1.7 µs (WRITE); READ costs a full round trip |
| Semantics | Message passing | **Remote memory** |

### One-sided: the mechanics and the hard part

An RDMA WRITE lands bytes in the target's memory. The target's CPU is never told. So **how does the target know new data arrived?** Three answers, each with a trap:

1. **Poll a flag written after the data.** Requires that the flag's write is ordered *after* the data's write. RDMA guarantees ordering between operations on the same QP for RC — but **a single large RDMA WRITE is not guaranteed to land in address order**, so an in-band trailing flag inside the same write is *not* safe on all hardware. Use two separate WRITEs on the same RC QP (ordered), or `IBV_WR_RDMA_WRITE_WITH_IMM`.
2. **`RDMA_WRITE_WITH_IMM`** — a write that also consumes a receive WQE at the target and generates a completion carrying a 32-bit immediate value. This is the clean way to get "data landed, and here is a tag", at the cost of the target having to post receives.
3. **Seqlock-style versioning** (Ch. 26 §26.9): write a version, the payload, then the version again; the reader spins until both versions match and are even. Robust against partial visibility, and the standard technique for one-sided shared structures.

### Where each belongs

- **Two-sided** is the natural fit for request/response and for message-oriented protocols: order entry, RPC, anything where the receiver must *act*. It is also simpler to make correct.
- **One-sided WRITE** is the fit for **state replication**: a primary continuously RDMA-writes its order book, position, or journal into a hot standby's memory. The standby's CPU spends zero cycles receiving it — it is entirely free on the receive side, which is the whole point (Ch. 56 §56.4). Failover then means the standby already has the state.
- **One-sided READ** costs a full network round trip and is used to fetch remote state on demand (distributed key-value stores). Rarely the right shape in trading, where you want data pushed to you before you need it.
- **RDMA ATOMIC** (compare-and-swap, fetch-and-add, 64-bit only) enables remote lock acquisition and distributed counters. Caveat: **atomicity is guaranteed against other RDMA operations, not necessarily against the target CPU's own loads and stores** unless the device advertises `IBV_ATOMIC_HCA`/`IBV_ATOMIC_GLOB`. Mixing a local `std::atomic` CAS with a remote RDMA CAS on the same address is a correctness hazard that surprises people.

**The interview-grade summary:** two-sided is message passing with the remote CPU in the loop; one-sided is remote memory with the remote CPU absent — which is a latency and CPU-efficiency win, and a correctness burden, because you must build your own arrival notification and your own ordering guarantees on top of it.

---

## 47.18 RoCE and InfiniBand

RDMA needs a lossless or near-lossless fabric, because its transport was designed assuming loss is rare and expensive to handle.

| | **InfiniBand** | **RoCEv2** | **iWARP** |
|---|---|---|---|
| Link layer | Native IB (not Ethernet) | Ethernet | Ethernet |
| Network layer | IB (LIDs, subnet manager) | **UDP/IP** (dst port 4791) — routable | TCP |
| Congestion / lossless | Credit-based flow control, lossless **by construction** | Requires **PFC** + **ECN/DCQCN** configured correctly | TCP's own congestion control |
| Switches | IB switches, needs a **subnet manager** (`opensm`) | Standard Ethernet switches, **DCB-configured** | Standard |
| Ecosystem | HPC | Datacenter, cloud | Legacy, largely dead |
| Latency | ~0.7–1.3 µs | ~1–2 µs | ~5–10 µs |

### The RoCE problem, stated precisely

RoCEv2 encapsulates the IB transport in UDP/IP over Ethernet. Ethernet drops packets under congestion; the IB transport (RC) responds to loss with a **go-back-N retransmission**, which at scale produces catastrophic throughput collapse and latency spikes. So RoCE requires the Ethernet fabric to be made lossless:

- **PFC** (Priority Flow Control, 802.1Qbb, Ch. 39 §39.11): per-priority PAUSE frames so a congested switch backpressures its upstream instead of dropping.
- **ECN + DCQCN**: end-to-end congestion notification so senders slow down before PFC is needed.

**PFC is genuinely dangerous.** Its failure modes are famous:
- **PFC deadlock**: a cyclic buffer dependency across switches locks the fabric solid. Requires careful topology or deadlock-avoidance routing.
- **Head-of-line blocking**: a PAUSE stops *all* traffic in that priority class, including flows destined elsewhere, propagating congestion outward — "congestion spreading".
- **PFC storms**: a misbehaving or misconfigured NIC PAUSEs continuously and takes down a whole fabric segment.

Microsoft's published RoCE-at-scale experience (the DCQCN papers and the "RDMA over Commodity Ethernet at Scale" retrospective) is the standard reference, and citing that RoCE's difficulty is *operational fabric configuration, not the NIC* is a mature answer.

**Diagnostics:** `ethtool -S` PFC counters (`rx_pause`, `tx_pause`, `rx_prio*_pause`), `rdma statistic`, `perfquery` on IB, and `ibv_devinfo` for port state and MTU. A rising `tx_pause` count on a trading host means the network is backpressuring *you*, and a rising `rx_pause` means your NIC is telling the switch to stop — both are latency events.

### Why RDMA is uncommon on the exchange-facing path

- Exchanges deliver UDP multicast and TCP over standard Ethernet; there is no RDMA on the venue side, so RDMA cannot shorten the wire-to-strategy path.
- RDMA's fabric requirements (lossless, subnet manager or DCB) do not survive a cross-connect to a third party.
- Its protection model (§47.16) assumes trust.

**Where it genuinely earns its place in trading**: *internal* fabrics — replicating state to a hot standby with one-sided writes (zero CPU on the standby), distributing normalised market data from a feed handler to many strategy hosts, shipping journals to a persistence tier (Ch. 56 §56.1), and any place where a receive costs a remote CPU nothing. Being able to draw that line — "RDMA for internal fan-out and replication, kernel bypass Ethernet for the venue path, FPGA for the last microsecond" — is the complete architectural answer this chapter is building toward (Ch. 52 §52.2).

---

## Key Interview Questions

1. **What exactly does kernel bypass remove, and what remains?** — Interrupt, `sk_buff` allocation, protocol demux, socket lock and queue, wakeup, `copy_to_user`, and the syscall. What remains is NIC internal latency, PCIe DMA, and the doorbell MMIO write — roughly 0.5–1 µs of irreducible hardware.
2. **Why is the tail improvement more valuable than the mean?** — Bypass removes every scheduling decision from the data path, collapsing p99.9 from ~50 µs to ~2 µs; trading is graded on the worst case.
3. **Why does DPDK require huge pages?** — Physical contiguity for DMA, pinned/unswappable pages, and TLB coverage of a large mbuf pool; 1 GB pages must be reserved at boot.
4. **What makes `rte_mbuf` faster than `sk_buff`?** — One 128-byte header co-located with its data in a preallocated mempool element with a per-lcore cache: zero allocations and 1–2 metadata cache lines per packet, versus two allocations and 8–15 lines.
5. **Onload versus ef_vi versus TCPDirect — when do you use each?** — Onload for a drop-in `LD_PRELOAD` acceleration of an existing socket application; ef_vi for a hand-written raw-frame market-data receive path at ~700–900 ns; TCPDirect for zero-copy user-space TCP order entry when a rewrite is acceptable.
6. **What is Onload's most dangerous failure mode?** — Silent non-acceleration: a socket on the wrong interface or using an unsupported option falls back to the kernel with no error. Verify with `onload_stackdump`.
7. **What is CTPIO?** — Cut-through programmed I/O: PIO stores push the frame straight into the NIC's TX FIFO so transmission begins before the frame is complete, removing the DMA fetch from the transmit path.
8. **AF_XDP versus DPDK?** — AF_XDP keeps the kernel driver, the tooling, and per-queue selectivity, at ~1.5–3 µs; DPDK detaches the driver entirely for ~0.8–1.5 µs and higher throughput. AF_XDP is the operability choice.
9. **What are the four AF_XDP rings and what breaks if you neglect one?** — FILL, RX, TX, COMPLETION. Neglecting FILL starves the driver of buffers and receive stops dead after exactly the initially filled count.
10. **Is `AF_PACKET` kernel bypass?** — No. The packet still traverses the driver, NAPI, and skb allocation; `PACKET_MMAP` only removes the copy and the per-packet syscall. It is the capture path, and it is what `tcpdump` uses.
11. **Would you write your own TCP stack?** — Buy TCP, build UDP. Market data is stateless receive-only multicast and is a few hundred lines over ef_vi; TCP carries the correctness risk, the timer coupling to your reactor loop, and a decade of exchange interop testing you cannot replicate.
12. **Why does a busy-poll loop help beyond removing the wakeup?** — It holds C0 (no 30–60 µs C-state exit), keeps caches, TLBs and branch predictors warm, holds turbo frequency, and removes the scheduler from the path.
13. **What is the ownership contract on a zero-copy receive ring, and how does violating it present?** — Buffers belong to the device until completion and must be reposted promptly. Holding them causes hardware drops with no software counter; reposting early causes intermittent garbage in later message fields, invisible to ASan.
14. **Why does the doorbell write need a fence?** — The descriptor stores must be globally visible before the doorbell. The doorbell typically lands in a write-combining region whose stores are weakly ordered, so an `SFENCE` (or `DMB ISHST` on ARM) is required; getting it wrong hangs the queue silently.
15. **What does `ibv_reg_mr` actually do, and why is it slow?** — Pins pages, builds the NIC's translation tables, and issues `lkey`/`rkey`. Tens to hundreds of microseconds, so register once at startup.
16. **What is the `fork()` hazard with registered memory?** — Copy-on-write can leave the NIC DMAing to a physical page the parent no longer owns. Call `ibv_fork_init()` before any registration.
17. **One-sided versus two-sided RDMA?** — Two-sided SEND/RECV involves the remote CPU and consumes a pre-posted receive; one-sided READ/WRITE/ATOMIC touches remote memory with the remote CPU entirely uninvolved and unaware — you must build your own arrival notification.
18. **How does a target learn that a one-sided write landed?** — `RDMA_WRITE_WITH_IMM` (generates a completion), a separately ordered flag write on the same RC QP, or a seqlock-style version pair. An in-band trailing flag inside one large write is unsafe because a single write need not land in address order.
19. **What is `IBV_SEND_INLINE` and why does it matter here?** — Small payloads are embedded in the WQE so the NIC needs no second DMA read to fetch data — several hundred nanoseconds saved, in exactly the message-size regime a trading system uses.
20. **Why is RoCE operationally hard?** — The IB transport assumes a lossless fabric, so Ethernet must be made lossless with PFC and ECN/DCQCN; PFC brings deadlock, congestion spreading, and pause storms. The difficulty is fabric configuration, not the NIC.
21. **Why is RDMA rare on the exchange-facing path?** — Venues deliver plain Ethernet UDP/TCP; RDMA's fabric requirements and its `rkey`-capability trust model do not cross an organisational boundary. It belongs on internal replication and fan-out.

---

## Common Traps

- **Choosing DPDK when Onload would do** — a multi-quarter rewrite versus a launcher change, for a few hundred nanoseconds.
- **Binding your management NIC to `vfio-pci`** — the interface vanishes and you lose the box.
- **Using `uio_pci_generic` instead of `vfio-pci`** — unprotected DMA, no IOMMU isolation.
- **Expecting 1 GB huge pages to be allocatable after boot** — memory is fragmented; reserve on the kernel command line.
- **Huge pages or mbuf pools on the wrong NUMA node** — a permanent 100–300 ns per packet that no code review will find.
- **Forgetting `RLIMIT_MEMLOCK`** — `vfio` DMA mapping and `ibv_reg_mr` fail with `ENOMEM` despite free memory.
- **Assuming Onload/VMA accelerated your socket** — silent fallback to the kernel with no error; always verify with `onload_stackdump` / `vma_stats`.
- **Benchmarking XDP in `generic` mode** — it runs after skb allocation and has none of the performance; check `ip link` for `xdpgeneric`.
- **Not refilling the AF_XDP FILL ring** — receive stops after exactly the initially posted count.
- **Holding zero-copy ring buffers while parsing downstream** — hardware drops with no visible counter.
- **Reposting a receive descriptor before finishing the parse** — the NIC overwrites your data mid-read; corruption appears only in later fields, only under load.
- **Assuming completions arrive in order** — match on `wr_id`, never on position.
- **Omitting the store fence before the doorbell** — the device never sees the write and the queue silently stops.
- **Letting a CQ overrun** — the QP transitions to `IBV_QPS_ERR` and every outstanding WR completes `WR_FLUSH_ERR`; the *first* non-flush status is the real error.
- **Never signalling sends** — the send queue fills and `ibv_post_send` fails; signal every Nth.
- **Using ODP on a latency path** — replaces registration cost with unbounded page-fault latency.
- **`fork()` after registering memory without `ibv_fork_init()`** — COW causes DMA into the wrong physical page.
- **Registering the whole heap and handing out its `rkey`** — the peer can read and write everything, unaudited.
- **Trying one-sided RDMA over UD** — one-sided operations require RC (or UC).
- **Mixing local `std::atomic` CAS with remote RDMA ATOMIC on the same address** — atomicity across the two domains is not guaranteed unless the device advertises it.
- **Deploying RoCE without PFC/ECN tuning** — go-back-N retransmission storms; and deploying PFC carelessly — fabric deadlock.
- **Running `SCHED_FIFO` busy loops on non-isolated cores** — you can wedge the machine; `sched_rt_runtime_us` is the only safety net.
- **Forgetting that bypass blinds every kernel counter** — `ethtool -S`, `nstat`, `ss`, and `tcpdump` no longer see your traffic; you must build the replacement observability first, not after the first incident.

---

## Compact Recall Summary

**Motivation.** A tuned kernel path costs ~3–5 µs with a p99.9 near 50 µs (Ch. 46). Bypass removes the interrupt, the `sk_buff`, the protocol demux, the socket lock and queue, the wakeup, the copy and the syscall, reaching ~0.8–1.5 µs with a p99.9 of ~2–3 µs. The tail collapse matters more than the mean. What remains is NIC internal latency, PCIe DMA, and the doorbell MMIO write. The bill: a core burned per polled queue, no kernel stack, no kernel tooling, hardware lock-in, deployment fragility, and a new class of ownership bugs.

**DPDK.** Poll-mode drivers over `vfio-pci` (the kernel driver is detached and the interface disappears). `rte_mbuf` is one 128-byte header co-located with its data in a preallocated mempool with per-lcore caches — zero allocations, 1–2 metadata cache lines, versus `sk_buff`'s two allocations and 8–15 lines. Burst API amortises the doorbell and enables prefetch pipelining, which is a throughput design, not a latency one. Requires huge pages for physical contiguity, pinning, and TLB coverage; 1 GB pages must be reserved at boot and placed on the NIC's NUMA node.

**Solarflare tiers.** **Onload** = `LD_PRELOAD` full user-space TCP/UDP behind the POSIX socket API, zero code change, ~1.2–2 µs, per-VI hardware filters providing isolation; its danger is silent fallback (verify with `onload_stackdump`). **ef_vi** = raw rings plus an event queue polled with a single phase-bit cache-line read (~20–40 ns idle), no protocol at all, ~0.7–1.0 µs; CTPIO pushes frames into the TX FIFO by PIO for sub-100 ns transmit initiation. **TCPDirect/zf** = bespoke API with true zero-copy `zft_zc_recv` into the ring, single-threaded stacks pumped by `zf_reactor_perform`, ~0.8–1.2 µs TCP. **VMA/XLIO** is NVIDIA's Onload equivalent, built on ibverbs raw-Ethernet QPs.

**Kernel-community options.** **XDP** runs verified eBPF in the driver before skb allocation: `DROP` (~10–20 ns, DDoS-grade), `TX`, `REDIRECT`, `PASS`; native/offloaded/generic modes, and benchmarking generic mode is a classic error. **AF_XDP** redirects frames into a user UMEM via four SPSC rings — FILL, RX, TX, COMPLETION — keeping the kernel driver, the tooling, and per-queue selectivity at ~1.5–3 µs. **`AF_PACKET`/`PACKET_MMAP`** is not bypass: the skb is still built and the frame is a *copy* to a tap; `TPACKET_V3` plus `PACKET_FANOUT` plus hardware timestamps is the correct capture path, and it is what `tcpdump` uses.

**User-space TCP.** Buy it (Onload/TCPDirect/XLIO), build UDP. The hard parts of rolling your own are timers coupled to your reactor loop (a slow strategy delays ACKs and provokes peer retransmits), retention of sent data for retransmission, crash-time connection state, and exchange interop.

**The poll loop.** One pinned thread on an isolated core spinning on a device-written cache line. Beyond removing the wakeup, spinning holds C0 (no 30–60 µs C-state exit), keeps caches/TLB/branch predictors warm, holds turbo, and deletes the scheduler from the data path. Requires `isolcpus`/`nohz_full`/`rcu_nocbs`, no `irqbalance`, SMT sibling handled, `PAUSE` in the empty branch, `mlockall` plus huge pages plus prefaulting, no allocation/locks/logging/blocking calls, and a warmup pass so the first real message is not 10× slower.

**Ownership.** Submission and completion rings in shared memory, signalled by producer/consumer indices or (better for polling) a per-entry phase bit. State machine: FREE → device-owned → app-owned → reposted. Never touch a device-owned buffer, never post twice, never assume completion order (match `wr_id`), keep the ring supplied or take invisible hardware drops, and **fence stores before the doorbell** — a write-combining doorbell without an `SFENCE` hangs the queue silently. Zero-copy receive saves the copy but mostly saves cache pollution and one serial pass; parse in place, copy out only retained fields, repost immediately.

**RDMA model.** PD groups MRs and QPs; MR = registered pinned memory with `lkey` (local) and `rkey` (remote capability); QP = send + receive queue; CQ = completions; SRQ shares receive buffers. `ibv_reg_mr` pins pages, builds the NIC's translation tables, and issues keys — tens to hundreds of µs, so register once at startup on the HCA's NUMA node over huge pages, and call `ibv_fork_init()` first if the process ever forks. RC is the only transport supporting one-sided operations; UD is connectionless send/recv only. `IBV_SEND_INLINE` embeds small payloads in the WQE and saves several hundred nanoseconds — the trading-message regime. Signal every Nth send; a CQ overrun kills the QP with a cascade of `WR_FLUSH_ERR` whose first non-flush entry is the real cause.

**One-sided versus two-sided.** Two-sided SEND/RECV involves the remote CPU and consumes a pre-posted receive — message passing, ~1.5–2.5 µs. One-sided READ/WRITE/ATOMIC touches remote memory with the remote CPU absent and unaware, ~1–1.7 µs — free on the receive side, which is why it is the right shape for hot-standby state replication. Arrival notification must be built: `RDMA_WRITE_WITH_IMM`, a separately ordered flag write on the same RC QP, or a seqlock version pair — never an in-band trailing flag in one large write, since a single write need not land in address order. The `rkey` is an unrevocable, unaudited 32-bit capability, so register minimal regions or use type-2 memory windows.

**Fabrics.** InfiniBand is lossless by construction with credit-based flow control and a subnet manager, ~0.7–1.3 µs. RoCEv2 puts the IB transport in UDP/IP over Ethernet (port 4791) and therefore needs PFC plus ECN/DCQCN to emulate losslessness — bringing deadlock, congestion spreading and pause storms; the difficulty is fabric configuration, not the NIC (watch `rx_pause`/`tx_pause`). iWARP over TCP is largely dead. RDMA does not appear on the venue-facing path — exchanges speak plain Ethernet and the trust model does not cross organisational boundaries — so the complete architecture is: **FPGA for the last microsecond (Ch. 48), kernel-bypass Ethernet for the venue path, RDMA for internal replication and fan-out, and a tuned kernel for everything else.**
