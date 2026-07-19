# Chapter 46 — The Linux Network Stack

*Interview-focused revision notes. The theme: trace one packet from the PHY to `recv()` and back, accounting for every copy, every lock, every context switch and every microsecond. This chapter is the cost model that Ch. 47 exists to escape — you cannot argue for kernel bypass without being able to say precisely what the kernel is charging you for.*

---

## 46.1 The Kernel Receive Path

The full journey of an inbound packet, with wall-clock costs on a modern colo host (Xeon ~3 GHz, 10/25 GbE, warm caches, no bypass):

```
 [1] Wire → NIC PHY/MAC                     ~ 0 ns (measured from here; hw timestamp point)
 [2] NIC filters, hashes (RSS), selects RX queue Q       ~ 100–300 ns internal NIC latency
 [3] NIC DMAs frame into the RX ring's buffer over PCIe   ~ 300–900 ns (PCIe TLP + DDIO)
 [4] NIC writes descriptor writeback + raises MSI-X       ~ 100 ns
 [5] CPU takes the interrupt, runs the driver's ISR       ~ 1–3 µs (interrupt latency, C-state exit!)
 [6] ISR masks IRQ, schedules NAPI, raises NET_RX_SOFTIRQ ~ 100 ns
 [7] softirq runs napi->poll(): builds sk_buff per frame  ~ 300–600 ns/pkt
 [8] GRO coalescing, then netif_receive_skb              ~ 200 ns
 [9] Protocol demux: ip_rcv → udp_rcv / tcp_v4_rcv       ~ 300–800 ns (routing, conntrack, netfilter)
[10] Socket lookup (hash), socket lock, enqueue to sk_receive_queue  ~ 200–500 ns
[11] Wake the blocked reader (or mark epoll ready)       ~ 1–5 µs (run-queue, IPI, context switch)
[12] recvmsg: copy_to_user, free skb                     ~ 200–400 ns
     ────────────────────────────────────────────────────────────────
     Total wire-to-application: ~5–15 µs typical, 3 µs best case with busy-poll,
     and a p99.9 tail of 50–200 µs under interference.
```

Two structural facts explain almost everything:

1. **The work is split across three execution contexts** — hardware interrupt (ISR), softirq (NAPI + protocol stack), and process context (`recvmsg`). Each boundary is a scheduling decision the kernel makes on your behalf, and each is a place where an unrelated workload can preempt you. This is why kernel-path latency has a *fat tail*: the mean is fine, the p99.9 is governed by whether softirq ran promptly and whether your thread got the CPU.

2. **The payload is touched at least twice**: once by DMA into a kernel page, once by `copy_to_user`. On a DDIO-enabled Intel platform the DMA lands in L3 (Ch. 29 §29.24), so the copy is L3→L1→L1, roughly 60–100 ns for 1500 bytes — cheap in isolation, but it evicts ~24 cache lines of your working set every packet.

### The two receive sub-paths

```
Interrupt-driven (default):  IRQ → NAPI softirq → stack → wake → app
Busy-polled (SO_BUSY_POLL):  app's recv() → napi_busy_loop() → stack → return
                             (steps [4]–[6] and [11] eliminated: ~8–10 µs saved)
```

Busy polling (Ch. 45 §45.8) is precisely the removal of the interrupt and the wakeup. Everything from `napi->poll` through `copy_to_user` still happens, and it is that residual ~2–3 µs of stack work that bypass removes.

### Where the tail comes from

| Source | Magnitude | Diagnostic |
|---|---|---|
| C-state exit on an idle core | 10–60 µs | `turbostat`, `cpupower idle-info`; fix with `idle=poll` or `/dev/cpu_dma_latency` (Ch. 35 §35.13) |
| softirq starvation by another softirq or a long-running kernel path | 10–100 µs | `/proc/softirqs`, `ksoftirqd` CPU time in `top` |
| Thread not on CPU when the packet arrives | 5–100 µs | `perf sched latency`, `runqlat` (bcc) |
| TLB/page-cache miss on the skb or user buffer | 1–10 µs | `perf stat -e dTLB-load-misses` |
| Interrupt landing on the wrong NUMA node | +200–500 ns/packet, worse under load | `/proc/interrupts`, `lstopo` (Ch. 29 §29.17) |

The single most important operational statement: **the kernel receive path's median is acceptable and its tail is not**, and tail latency is what a trading system is graded on (Ch. 43 §43.2).

---

## 46.2 The Kernel Transmit Path

Transmit is *mostly synchronous in the calling thread*, which surprises people who assume `send()` is a queue push.

```
 [1] send()/sendmsg(): syscall entry                        ~ 50–200 ns
 [2] Socket lock; check send-buffer budget (sk_wmem_alloc)
 [3] Allocate sk_buff(s); copy_from_user into skb pages     ~ 100 ns/1.5 KB
 [4] TCP: build header, sequence numbers, choose whether Nagle/cwnd
        permit sending now (Ch. 38 §38.13)
 [5] ip_queue_xmit: route lookup (usually cached in the socket's dst entry),
        netfilter OUTPUT + POSTROUTING hooks                ~ 200–600 ns
 [6] Traffic control (qdisc) enqueue → dequeue              ~ 200–800 ns (pfifo_fast/mq)
 [7] Driver ndo_start_xmit: fill TX descriptor(s), possibly
        segment (TSO) and offload checksum                  ~ 200 ns
 [8] MMIO write to the NIC's TX doorbell register           ~ 200–1000 ns  ← uncached PCIe write
 [9] NIC DMAs the buffer, transmits, later posts a TX completion
[10] TX completion IRQ/NAPI frees the skb                   (off the critical path)
     ─────────────────────────────────────────────────────────────────
     Application send() to wire: ~1.5–4 µs
```

**Step [8] is the one candidates miss.** The doorbell is an uncached write to a PCIe BAR. It is a *posted* write, so the store itself does not block for the round trip, but it must drain the write-combining buffer and traverse the PCIe root complex; the observable cost in the sending thread is a few hundred nanoseconds and it does not pipeline with anything. Every kernel-bypass API's fast path is ultimately "build a descriptor, ring the doorbell", and that MMIO write is the irreducible floor — around 100–300 ns even in DPDK.

### The qdisc layer

Between IP and the driver sits **traffic control**. The default is `mq` (one qdisc per hardware TX queue) with `pfifo_fast` or `fq_codel` beneath. Costs and hazards:

- **A single-queue qdisc is a global lock.** If the root qdisc is not `mq`/`mq`-like, every transmitting core contends on `qdisc->q.lock`, producing a cache-line bouncing hotspot (Ch. 26 §26.15). Symptom: `perf top` showing `__qdisc_run` / `dev_queue_xmit` under lock contention, throughput plateauing well below line rate.
- **`noqueue`** (available on virtual devices, and settable) bypasses the layer entirely: `tc qdisc replace dev eth0 root noqueue` or using `mq` with `pfifo_fast` and a small `txqueuelen`. For latency-sensitive hosts the standard tuning is `mq` + minimal queueing, so that backpressure appears as a full TX ring rather than a deep software queue (bufferbloat, Ch. 38 §38.19).
- **BQL (Byte Queue Limits)** dynamically limits in-flight bytes in the TX ring to bound the transmit-side standing queue. `/sys/class/net/eth0/queues/tx-N/byte_queue_limits/`. Good for latency; occasionally needs raising for tiny-packet workloads.
- **XPS** (§46.13) selects which TX queue a thread uses, which determines which qdisc lock it takes.

### Skb ownership on transmit

The skb is freed by the **TX completion** path, not by `send()`. Two consequences:

1. `sk_wmem_alloc` (bytes charged to the socket) only drops when completions are processed. If TX completion processing is delayed — because completion interrupts are heavily coalesced (§46.6) — the socket appears full and `send()` blocks or returns `EAGAIN` even though the wire is idle. **Diagnostic signature: `ss -tim` showing a large `wmem_alloc` with an empty `Send-Q` and no congestion-window limitation.** Fix: reduce TX coalescing (`ethtool -C eth0 tx-usecs 0 tx-frames 1`).
2. This is exactly the ownership-transfer protocol of Ch. 45 §45.17; `MSG_ZEROCOPY` just makes it visible to the application.

---

## 46.3 NIC DMA Descriptor Rings

A **descriptor ring** is a contiguous circular array of fixed-size descriptors in host memory, shared between the driver and the NIC, plus head/tail indices. It is the fundamental producer/consumer interface to every modern NIC (Ch. 29 §29.22).

```
RX ring (driver produces empty buffers, NIC consumes them):

  index:   0     1     2     3     4     5     6     7
        [used][used][used][ NEW ][ NEW ][free][free][free]
                            ^                  ^
                        NIC head          driver tail (doorbell written here)
        ^^^^^^^^^^^^^^^^^^^^
        filled by NIC, awaiting driver processing

Each descriptor: { u64 buffer_dma_addr; u16 len; u16 status/flags; ... }
```

The protocol:
1. Driver allocates buffers, maps them for DMA (`dma_map_single` / a DMA pool), writes their bus addresses into descriptors, and advances the **tail** by writing an MMIO doorbell register. These are now "owned by the NIC".
2. Frame arrives; NIC DMAs it into the next descriptor's buffer, then **writes back** the descriptor with length, status, RSS hash, checksum result, and (if enabled) a hardware timestamp — setting a DD ("descriptor done") bit.
3. Driver polls the DD bit (or is interrupted), takes the buffer, and refills the slot.

### Details that matter

- **Two DMA transactions per packet**, not one: the frame data, and the descriptor writeback. Both traverse PCIe. On Intel with **DDIO** (Ch. 29 §29.24) both land in a reserved portion of L3 rather than DRAM, saving ~80 ns on the driver's first touch and avoiding a DRAM round trip. DDIO's L3 allocation is limited (2 ways by default); a ring set too large blows past it and every descriptor read becomes a DRAM access. **This is the concrete reason "bigger rings are always better" is false.**
- **Ring size** (`ethtool -g eth0`; `ethtool -G eth0 rx 512`) trades drop-resistance against latency and cache footprint. A 4096-entry ring at 10 GbE holds ~5 ms of line-rate traffic — meaning a packet at the back is 5 ms stale by the time you see it. Low-latency tuning uses **small rings (512–1024)** so that overload manifests as drops (which you detect and account for) rather than as latency (which silently poisons your prices). Ch. 48 §48.13.
- **The doorbell write is the expensive part.** Drivers batch refills (e.g. every 32 descriptors) precisely to amortise it.
- **Descriptor formats vary**: legacy 16-byte, "advanced" 32-byte with RSS hash and timestamps, and split header/data descriptors that DMA the header into one buffer and the payload into another (enabling header-only inspection without touching payload cache lines).
- **IOMMU** (Ch. 29 §29.23) sits in the path: with `intel_iommu=on` in strict mode, every `dma_map`/`unmap` invalidates an IOTLB entry, adding hundreds of nanoseconds per packet and a global invalidation storm at high rates. Latency-tuned hosts use `iommu.passthrough=1` or `iommu=pt` — trading device-DMA isolation for latency, which is a deliberate, statable security trade-off.

**Diagnostics:** `ethtool -g` (ring sizes), `ethtool -S eth0 | grep -i 'rx_no_buffer\|rx_missed\|fifo'` (ring exhaustion), `/proc/interrupts` (per-queue IRQ counts), and PCIe counters via `lspci -vvv` for `AER` errors and link width/speed (a card negotiated to x4 instead of x8 is a real and easily missed 2× bandwidth loss).

---

## 46.4 Interrupt-Driven Packet Processing

The naïve model — one interrupt per packet — was how NICs worked before ~2002, and it does not survive contact with modern line rates.

At 10 GbE with 64-byte frames, line rate is **14.88 million packets per second**, i.e. one packet every **67.2 ns**. An interrupt costs 1–3 µs of entry, handler, and `iret`. One IRQ per packet at line rate demands 30–45 CPU-seconds per second. The system enters **receive livelock**: it spends 100% of its time taking interrupts, never returns to process context, and throughput collapses to *zero* as offered load rises — the classic Mogul & Ramakrishnan result, and a good thing to be able to name.

### What an interrupt actually costs

```
MSI-X message written by NIC over PCIe
  → LAPIC delivers to the targeted core
  → CPU pipeline flush, privilege transition, IDT dispatch     ~ 0.5–1.5 µs
  → driver ISR: read cause register (a PCIe *read* — 500–2000 ns!, uncached, blocking)
  → mask the interrupt source, napi_schedule(), raise softirq
  → iret, plus the cache/TLB pollution of having run kernel code
```

The **PCIe read of the interrupt-cause register is the sting**: unlike posted writes, an MMIO read blocks for the full round trip through the root complex, typically 0.5–2 µs. Modern drivers use MSI-X with per-queue vectors precisely so the vector *identifies* the cause and no register read is needed.

**MSI-X versus legacy:**

| | Legacy INTx | MSI | MSI-X |
|---|---|---|---|
| Delivery | Shared level-triggered pin | Posted memory write | Posted memory write |
| Vectors | 1, shared | up to 32, contiguous | up to 2048, independent |
| Per-queue steering | No | Limited | **Yes — each RX queue gets its own vector and its own CPU affinity** |
| Cause register read needed | Yes | Usually | No |

Per-queue MSI-X is what makes RSS (§46.12) and per-core affinity (§46.15) possible at all.

### C-states: the hidden interrupt tax

An interrupt arriving at a core in C6 must wake it: 30–60 µs of exit latency on some parts. On an otherwise-idle low-rate feed, **the first packet after a quiet period is dramatically slower than the rest** — a bimodal latency histogram with a cluster at ~50 µs. This is one of the most common "my latency is fine in the load test and terrible in production at 3am" stories. Fixes: `idle=poll` (burns power), `intel_idle.max_cstate=1`/`processor.max_cstate=1`, or holding `/dev/cpu_dma_latency` open with a 0 written to it (Ch. 35 §35.13). Busy-polling a core keeps it in C0 as a side effect, which is part of why busy-poll architectures have such tight distributions.

---

## 46.5 NAPI Polling

**NAPI** (New API) is the hybrid that resolves the interrupt/livelock problem: *interrupt to learn that work exists, then poll to do it.*

```
packet arrives → IRQ fires
              → ISR: napi_schedule(napi); DISABLE this queue's interrupts; return
              → NET_RX_SOFTIRQ runs napi->poll(napi, budget)
                    process up to `budget` packets from the RX ring
              → if fewer than budget were available:
                       napi_complete_done(); RE-ENABLE interrupts
                 else: leave interrupts off, stay in the softirq poll list,
                       and be re-polled (possibly by ksoftirqd)
```

The elegance: **at low rates you get interrupt latency (fast); at high rates interrupts are automatically off and you get polling throughput (efficient).** The transition is self-regulating with no tuning knob.

### The budget mechanism

| Knob | Default | Meaning |
|---|---|---|
| `net.core.netdev_budget` | 300 | Total packets one `NET_RX_SOFTIRQ` invocation may process across *all* NAPI instances |
| `net.core.netdev_budget_usecs` | 2000 (2 ms) | Time limit for the same |
| Per-NAPI `weight` | 64 | Packets per `poll()` call for one instance |
| `net.core.dev_weight` | 64 | Default weight |

When the softirq exhausts its budget with work remaining, it re-raises `NET_RX_SOFTIRQ`. If softirqs are re-raised too many times in a row (`MAX_SOFTIRQ_RESTART`, 10) or 2 ms elapses, processing is deferred to the **`ksoftirqd/N` kernel thread**, which is a normal `SCHED_OTHER` task. **This is a latency cliff**: your packets are now processed by a thread competing with everything else on the run queue, adding tens to hundreds of microseconds.

**Diagnostic signature:** the third column of `/proc/net/softnet_stat` (per-CPU) is `time_squeeze` — the count of times NAPI ran out of budget with work remaining. A rising `time_squeeze` plus visible `ksoftirqd` CPU time in `top` is the canonical "your NAPI budget is too small or your core is oversubscribed" evidence.

```
$ cat /proc/net/softnet_stat
# col1 = processed, col2 = dropped (backlog full), col3 = time_squeeze, col10 = backlog_len
0021a3f1 00000000 0000012c 00000000 ...
           ^ drops              ^ time_squeeze — the number to watch
```

### NAPI and busy polling

`SO_BUSY_POLL` (Ch. 45 §45.8) calls `napi_busy_loop()`, which invokes the *same* `napi->poll` from process context. Two contenders for one ring is a real hazard, so 5.11+ added:

- **`napi_defer_hard_irqs`** (`/sys/class/net/eth0/napi_defer_hard_irqs`): after a poll finds no work, defer re-enabling interrupts for N further polls.
- **`gro_flush_timeout`**: a timer that re-triggers NAPI even with interrupts disabled.
- **`SO_PREFER_BUSY_POLL`**: makes `napi_complete_done` honour the deferral so the application's busy loop remains the driver of the ring.

Setting `napi_defer_hard_irqs=2` and `gro_flush_timeout=200000` (200 µs) with `SO_PREFER_BUSY_POLL` is the canonical low-latency NAPI configuration: interrupts essentially never fire while traffic flows, the app polls, and the timer is a safety net if the app stalls.

### Threaded NAPI

Linux 5.12 added `/sys/class/net/eth0/threaded` = 1, moving NAPI polling out of softirq into a per-queue kernel thread (`napi/eth0-N`). This is valuable for latency because those threads can be **pinned and given `SCHED_FIFO` priority** (Ch. 31 §31.15), taking packet processing off the shared softirq context and out of `ksoftirqd`'s scheduling class. It is the standard answer to "how do you make kernel-path packet processing preemption-resistant without bypass."

---

## 46.6 Interrupt Coalescing Trade-offs

Coalescing tells the NIC to delay the interrupt until either `N` packets have arrived or `T` microseconds have elapsed since the first.

```bash
ethtool -c eth0                      # show
ethtool -C eth0 rx-usecs 0 rx-frames 1 adaptive-rx off     # minimum latency
ethtool -C eth0 rx-usecs 50 rx-frames 32                   # throughput/efficiency
```

| Setting | Latency added | Interrupt rate at 1 Mpps | Use |
|---|---|---|---|
| `rx-usecs 0, rx-frames 1` | ~0 | up to 1 M/s → livelock risk (NAPI mitigates) | Latency-critical feed handler |
| `rx-usecs 10` | up to 10 µs | ≤100 k/s | Balanced |
| `rx-usecs 50, rx-frames 32` | up to 50 µs | ≤20 k/s | Throughput servers |
| `adaptive-rx on` | **variable, 5–200 µs** | dynamic | Default; **latency poison** |

The critical points:

1. **Coalescing adds latency to the *first* packet of a burst**, which is precisely the packet you care about — the one carrying the price update that triggers your trade. A `rx-usecs` of 50 means the first packet of an idle-period burst waits up to 50 µs.
2. **`adaptive-rx` is the default on most drivers and is actively harmful for trading.** It varies the delay based on observed traffic, so your latency distribution becomes a function of *other people's* traffic patterns. Turn it off. Its signature is an inexplicably multi-modal latency histogram.
3. **NAPI already provides most of the interrupt-rate reduction that coalescing was invented for.** Under sustained load, interrupts are disabled anyway. Coalescing therefore mostly hurts at low-to-moderate rates and helps little at high rates — which is exactly backwards for a market-data workload that is bursty and mostly idle.
4. **TX coalescing** is a separate axis and matters for a different reason (§46.2): delayed TX completions delay skb freeing and can stall `send()` with a full `sk_wmem_alloc` while the wire is idle.

**The standard low-latency NIC baseline:**
```bash
ethtool -C eth0 adaptive-rx off adaptive-tx off rx-usecs 0 rx-frames 1 tx-usecs 0 tx-frames 1
ethtool -G eth0 rx 512 tx 512          # small rings: fail fast, don't queue stale data
ethtool -K eth0 gro off lro off        # §46.9 — GRO adds latency
ethtool -L eth0 combined <n_cores>     # one queue per handler core
```
Being able to recite that block, and justify each line, is a concrete demonstration of hands-on experience.

---

## 46.7 `sk_buff`

The `sk_buff` ("socket buffer", universally "skb") is the kernel's packet metadata structure — the single most important data structure in the network stack, and one of its biggest costs.

```
 struct sk_buff (~232 bytes on x86-64, 4 cache lines)
 ├── next, prev            (list linkage)
 ├── sk                    (owning socket)
 ├── dev                   (net_device)
 ├── cb[48]                (control block: per-layer scratch, e.g. TCP_SKB_CB)
 ├── len, data_len, truesize
 ├── head, data, tail, end (pointers into the linear data area)
 ├── transport_header, network_header, mac_header  (offsets)
 ├── hash, queue_mapping, napi_id, tstamp
 └── flags: ip_summed, pkt_type, cloned, gso_size, gso_segs, ...

 Data buffer (separate allocation):
   [ headroom ][  linear data  ][ tailroom ][ struct skb_shared_info ]
                                              └─ frags[] (page fragments), frag_list,
                                                 gso info, refcount, destructor
```

### Why the design costs what it does

- **Two allocations per packet**: the `sk_buff` itself (from a dedicated slab cache, `skbuff_head_cache`) and the data buffer (from a page-fragment allocator). ~100–200 ns combined, plus the free on the other end. At 1 Mpps this is a permanent 20% of a core doing nothing but allocation.
- **`truesize` versus `len`**: `truesize` is the *charged* memory including the skb, the buffer, and shared info. A 64-byte UDP datagram typically has a truesize of 768–2304 bytes depending on the driver's allocation strategy. This is the mechanism behind the `SO_RCVBUF` accounting surprise in Ch. 45 §45.7: your 2 MB buffer holds far less payload than you think. **Some drivers allocate a full page (or half page) per packet regardless of size**, so a 64-byte packet can be charged 2048 bytes — a 32× accounting inflation. Diagnostic: `ss -tim` `skmem` showing `r` (rmem_alloc) far exceeding the payload you have read.
- **Headroom** exists so that headers can be *prepended* without reallocating — encapsulation, VLAN tags. `NET_SKB_PAD` (64 bytes, aligned) is the default. A driver with insufficient headroom forces `skb_realloc_headroom`, a copy, in any tunnelling path.
- **Layer headers are offsets, not pointers**, so the skb survives reallocation of the data area. Accessing them costs a pointer add — cheap, but the `head`/`data` indirection means header access is a dependent load chain that can miss cache.
- **Cloning versus copying**: `skb_clone` shares the data buffer and copies only the `sk_buff` (used by `tcpdump`/`AF_PACKET` taps and by TCP retransmission queues). `pskb_copy`/`skb_copy` duplicate data. A `cloned` skb cannot be modified in place, so an in-path tap silently forces copies downstream — **running `tcpdump` measurably changes latency**, which is why capture must be done on a mirror port or with hardware timestamping (Ch. 48 §48.7).

### The cache-footprint argument

Four cache lines of `sk_buff` plus the data buffer's first line, touched by the driver, by GRO, by the protocol handlers, and by the socket layer — each stage touching a different subset. A packet crossing the stack causes roughly 8–15 cache-line fetches of *metadata alone*, before any payload. This, more than the copies, is why the kernel path costs microseconds while DPDK's `rte_mbuf` (a single 128-byte structure co-located with its data, Ch. 47 §47.2) costs hundreds of nanoseconds. **"The kernel's problem is not that it copies; it is that `sk_buff` is a general-purpose structure with a general-purpose lifecycle"** is the sophisticated form of this answer.

---

## 46.8 Socket Receive and Send Queues

The final kernel structure before user space. Each `struct sock` has:

| Queue | Contents | Guarded by |
|---|---|---|
| `sk_receive_queue` | skbs ready for `recvmsg` | `sk_receive_queue.lock` |
| `sk_backlog` | skbs that arrived while the socket lock was held by a process | socket lock |
| `sk_write_queue` | TCP: skbs sent but not yet acknowledged (the retransmission queue) | socket lock |
| `sk_error_queue` | Errors, TX timestamps, zerocopy completions (Ch. 45 §45.15) | its own lock |
| `out_of_order_queue` | TCP: segments received ahead of a gap | socket lock |

### The backlog: a subtlety worth knowing

When a softirq delivers a packet to a socket whose lock is held by a process (in `recvmsg`), it cannot enqueue to the receive queue. Instead it appends to `sk_backlog`. When the process releases the socket lock, it *processes the backlog itself* (`release_sock` → `__release_sock`). Two consequences:

1. **A `recvmsg` call can be charged with processing packets for other, later arrivals** — receive-path work migrates into your application thread, adding unpredictable time to a syscall you thought was a copy. This is a genuine source of `recv()` latency variance.
2. **Backlog overflow drops packets.** For TCP, the limit is `sk_rcvbuf`; overflow increments `TcpExtTCPBacklogDrop`. For UDP, `sk_backlog` overflow shows as `UdpRcvbufErrors`.

### TCP receive: three-stage

```
 skb → out_of_order_queue (if there is a sequence gap)
     → sk_receive_queue   (in-order, waiting for the app)
     → [fast path] direct copy into a user buffer if the app is already
       blocked in recvmsg with a pre-posted buffer (tcp_recv_skb "prequeue"
       — removed in 4.16; the modern equivalent is the busy-poll path)
```

A sequence gap (Ch. 38 §38.12) leaves data stranded in the out-of-order queue and stalls *all* subsequent bytes: **head-of-line blocking** (Ch. 38 §38.15). The application sees a latency spike of exactly one retransmission RTO or fast-retransmit round trip, and no error. Diagnostic: `nstat` `TcpExtTCPOFOQueue`, plus `ss -ti` showing `retrans`, `lost`, `sacked`.

### Send queue and window accounting

`sk_wmem_queued` (bytes in the write queue) and `sk_wmem_alloc` (bytes charged, including skbs handed to the driver but not yet completed) govern when `send` blocks. `TCP_NOTSENT_LOWAT` (Ch. 45 §45.13) limits only the *unsent* portion, which is the knob that keeps your newest order near the front of the queue.

**The interview point:** the socket queues are where the kernel's *unbounded queueing* lives. Every microsecond a packet spends here is a microsecond of staleness. For market data, the correct posture is a shallow queue plus an explicit staleness measurement (compare the hardware RX timestamp on the packet to `rdtsc` at parse time, Ch. 45 §45.9), not a deep queue that hides the problem.

---

## 46.9 GRO and LRO

Both merge multiple received segments of the same flow into one large skb, so the stack is traversed once instead of N times.

| | **LRO** (Large Receive Offload) | **GRO** (Generic Receive Offload) |
|---|---|---|
| Where | In the NIC hardware/firmware | In software, in the NAPI poll loop |
| Reversible | **No** — information is lost | **Yes** — GSO metadata preserves the segmentation |
| Forwarding-safe | **No** — breaks routing/bridging correctness | Yes |
| Merge criteria | Vendor-defined, loose | Strict: same 4-tuple, contiguous sequence, matching TCP options, no flags |
| Status | Deprecated; disable it | Default-on |

**LRO must be off** on any host that forwards or bridges (it violates the end-to-end principle by rewriting the stream irreversibly), and it is off by default in most modern setups. GRO is the survivor.

### GRO mechanics and its latency cost

During `napi->poll`, arriving segments are held in a per-NAPI GRO list. A segment merges with an existing entry if the flow matches and the sequence is contiguous; the merged skb accumulates page fragments in `skb_shinfo->frags`. The list is flushed to the stack when:
- a non-mergeable packet for the flow arrives (PSH flag, out-of-order, different flow filling the list),
- `MAX_GRO_SKBS` (8) entries exist,
- **`napi_complete_done` runs — i.e. at the end of the NAPI poll**,
- or `gro_flush_timeout` expires.

**The latency cost is bounded by the flush point, not by a timer**, which is the crucial nuance. Within a single NAPI poll, a packet may wait for the rest of the poll to complete — typically a few microseconds, not the tens of microseconds people assume. But if `gro_flush_timeout` is set (as in the busy-poll tuning of §46.5), a lone packet can wait for that timer.

For **TCP bulk transfer**, GRO is a large win: a 64 KB GRO'd skb traverses the stack once, so per-byte stack cost drops ~40×, and it is a major contributor to 10 GbE+ line rate on a single core.

For **market data**:
- **UDP GRO** (`UDP_GRO`, kernel 5.0+) merges same-flow datagrams and is *wrong* for latency-sensitive feeds — it delays the first datagram to see if a second arrives.
- **TCP order-entry** connections carry small, latency-critical messages that never merge anyway (each has PSH set, and they arrive one at a time), so GRO costs a little bookkeeping and gains nothing.

Hence `ethtool -K eth0 gro off lro off` in the low-latency baseline (§46.6). The honest framing: **GRO trades a few microseconds of latency for a large throughput gain; a feed handler wants the microseconds and does not need the throughput.**

---

## 46.10 GSO and TSO

The transmit-side mirror image: hand the hardware one large buffer plus a segment size, and let it produce MTU-sized packets.

| | **TSO** (TCP Segmentation Offload) | **GSO** (Generic Segmentation Offload) |
|---|---|---|
| Where | NIC hardware | Software, in the kernel, as late as possible |
| Applies to | TCP (and `UFO`/`USO` for UDP on some NICs) | TCP, UDP (`UDP_SEGMENT`), tunnels |
| Fallback | — | Used when the NIC lacks the offload |
| Benefit | Stack traversed once per 64 KB instead of per 1448 B | Same, minus the PCIe/DMA savings |

```
send(64 KB) → one skb with gso_size=1448, gso_segs=45
            → traverses IP, netfilter, qdisc, driver ONCE
            → NIC (TSO) emits 45 Ethernet frames, generating per-segment
              sequence numbers, IP IDs, and checksums in hardware
```

The win is roughly 45× fewer traversals of steps [4]–[7] of §46.2, which is the difference between ~3 Gbps and ~30 Gbps of TCP on one core.

### The latency and correctness caveats

- **TSO adds transmit latency for the *first* segment**: the NIC must DMA the whole 64 KB super-frame before it can emit segment 1. At 10 GbE, DMAing 64 KB takes ~52 µs of serialization; a first-segment delay of tens of microseconds is real. For order entry, where messages are 60–200 bytes, TSO never engages (the message is under one MTU) and the point is moot — but on a shared NIC where a bulk transfer is using TSO, **your small order packet queues behind a 64 KB super-frame**, adding up to 52 µs of head-of-line blocking at the TX ring. That is one of the strongest arguments for *dedicated NICs* for order entry, and it is a superb answer to "why do you not share the NIC?"
- **`UDP_SEGMENT` (USO/GSO for UDP)** is the transmit twin of §45.11's batching: one `sendmsg` with a `UDP_SEGMENT` cmsg carrying a segment size produces N datagrams from one syscall. Excellent for a replay/retransmission server.
- **TSO interacts with pacing**: with `fq` qdisc and TCP pacing, TSO super-frames are broken into paced bursts (`tso_max_size`, `sk_pacing_shift`), which changes the on-wire microburst profile (Ch. 39 §39.5).
- **Disabling TSO** (`ethtool -K eth0 tso off gso off`) raises CPU cost substantially and is only correct on a dedicated low-latency interface where you never send bulk data.

**The `ethtool -k` output is the inventory**: `tcp-segmentation-offload`, `generic-segmentation-offload`, `generic-receive-offload`, `large-receive-offload`, `rx-checksumming`, `tx-checksumming`, `scatter-gather`. Note that **disabling scatter-gather implicitly disables TSO**, since TSO requires SG — a dependency that surprises people when a single `ethtool -K` line silently turns off three features.

---

## 46.11 Checksum Offload

The Internet checksum (Ch. 36 §36.10) is a one's-complement sum over the whole payload — for a 1500-byte frame that is ~750 16-bit additions, roughly 100–200 ns and, worse, a full pass over the payload that pollutes cache.

### Receive-side

The NIC validates L3/L4 checksums and reports the result in the descriptor. The driver sets `skb->ip_summed`:

| Value | Meaning |
|---|---|
| `CHECKSUM_NONE` | Not checked; the stack must do it in software |
| `CHECKSUM_UNNECESSARY` | Hardware verified it; the stack skips verification entirely |
| `CHECKSUM_COMPLETE` | Hardware computed a raw sum over the whole frame; the stack folds in the pseudo-header cheaply. **Preferred** — it remains valid after header stripping and works for protocols the NIC does not parse |
| `CHECKSUM_PARTIAL` | (TX) The stack filled the pseudo-header sum; the NIC must complete it |

### Transmit-side

The stack writes the pseudo-header checksum into the packet, sets `CHECKSUM_PARTIAL` with `csum_start`/`csum_offset`, and the NIC computes the rest during DMA. Free, in the sense that it overlaps transmission.

### Consequences worth knowing

- **`tcpdump` on the transmit side shows "incorrect checksum" for every packet.** This is not a bug: the capture tap runs *before* the NIC fills in the checksum. Every network engineer has chased this ghost once; recognising it instantly is a good signal.
- **UDP checksum 0 is legal in IPv4** (meaning "not computed") and **illegal in IPv6** (where it is mandatory, except for specific tunnelling cases). Some exchanges send zero-checksum UDP market data to save sender-side work; a receiver that rejects it is broken.
- **Offload does not cover everything.** Encapsulated/tunnelled packets, unusual protocols, and IP options often fall back to software checksums, silently costing microseconds. `ethtool -S` and `perf top` showing `csum_partial` is the signature.
- **Do not disable checksum offload** in the name of determinism; the software path is strictly slower and no more predictable.

The general principle to state: checksum offload is the one offload that is unambiguously good for latency, because it removes a full payload pass without introducing any batching or delay. GRO/TSO trade latency for throughput; checksum offload does not.

---

## 46.12 Receive-Side Scaling

**RSS** is a NIC hardware feature: hash selected header fields, index a redirection table, and choose an RX queue. Each queue has its own descriptor ring, its own MSI-X vector, and (via IRQ affinity, §46.15) its own CPU.

```
                       ┌─ hash(src_ip, dst_ip, src_port, dst_port) ──┐
frame ──► NIC parser ──┤                                              ├─► indirection
                       └─ Toeplitz over the 4-tuple with a 40B key ──┘   table[hash & 127]
                                                                              │
                                              ┌───────────────┬───────────────┴──────┐
                                            RXQ0            RXQ1                   RXQ7
                                          MSI-X 0         MSI-X 1                MSI-X 7
                                           CPU 0           CPU 1                  CPU 7
```

Why it exists: a single RX queue and a single core cannot process 10/25/100 GbE. RSS gives horizontal scaling *in hardware*, before any software touches the packet.

### Key properties

- **Flow affinity is preserved.** All packets of one 4-tuple hash identically, so they go to one queue and one core, in order. This is what keeps TCP reordering out of the picture (Ch. 39 §39.10) and gives cache locality for per-connection state.
- **The hash is Toeplitz over a configurable 40-byte key.** `ethtool -x eth0` shows the indirection table and key; `ethtool -X eth0 equal 4` or `weight ...` reprograms the table; `ethtool -n eth0 rx-flow-hash udp4` shows which fields are hashed.
- **UDP is often hashed on IP addresses only, not ports, by default.** `ethtool -N eth0 rx-flow-hash udp4 sdfn` enables 4-tuple hashing (s=src IP, d=dst IP, f=src port, n=dst port). Without it, **all multicast market data from one source IP lands on one queue and one core** — an extremely common and severe misconfiguration whose signature is one core at 100% softirq while seven are idle. Fixing this single setting has salvaged many feed handlers.
- **Multicast and RSS interact badly** in general: the same group to the same port from one source is one flow by definition, so RSS cannot spread it. Spreading a single high-rate multicast feed requires application-level partitioning or NIC flow steering (§46.14) on inner fields.
- **`ethtool -L eth0 combined N`** sets the number of queues. For a latency architecture, set N equal to the number of dedicated handler cores, and steer explicitly — do not use 64 queues on a 64-core box and let interrupts land anywhere.

**Symmetric RSS** is the non-obvious refinement: with the default key, the hash of (A→B) differs from (B→A), so the two directions of a TCP connection land on different cores. A **symmetric Toeplitz key** (the well-known repeating `0x6D5A` pattern) makes both directions hash identically, which matters for stateful middleboxes and for any design that wants send and receive processing on the same core with the same warm state. Knowing that symmetric keys exist and why is a strong differentiator.

---

## 46.13 RPS, RFS and XPS

Software-side counterparts to RSS, used when hardware steering is absent or insufficient.

| | **RPS** | **RFS** | **XPS** |
|---|---|---|---|
| Full name | Receive Packet Steering | Receive Flow Steering | Transmit Packet Steering |
| Direction | RX | RX | TX |
| Decides | Which CPU processes the packet's stack traversal | Same, but based on where the *application* runs | Which TX queue a transmitting CPU uses |
| Mechanism | Software hash → target CPU, delivered via IPI to that CPU's backlog | A flow table records the CPU that last called `recvmsg` for the flow; packets follow it | Per-CPU TX queue mask in sysfs |
| Configured | `/sys/class/net/eth0/queues/rx-N/rps_cpus` (bitmask) | `rps_flow_cnt` + `net.core.rps_sock_flow_entries` | `/sys/class/net/eth0/queues/tx-N/xps_cpus` |
| Cost | **An inter-processor interrupt and a cache-line transfer per packet** | Same, plus table lookups | None (it removes cost) |

### RPS

RPS is "RSS in software": the receiving CPU hashes the packet, enqueues it to another CPU's backlog queue, and sends an IPI. It exists for NICs with one queue or no RSS. **It is almost never right on a modern low-latency host** — you already have RSS, and RPS adds an IPI (~1–2 µs) plus a cross-core cache-line migration of the skb per packet. Its legitimate use is a single-queue virtual NIC.

### RFS — the interesting one

RSS steers by *hash*, which is blind to where the application actually runs. If the flow hashes to CPU 3 but your handler thread runs on CPU 7, every packet's socket data is written on CPU 3 and read on CPU 7: a cross-core cache-line transfer for the skb, the socket's receive queue head, and the socket lock — 100–300 ns each, plus coherence traffic (Ch. 28 §28.7).

RFS fixes it in software by remembering, per flow, the CPU on which `recvmsg` last ran, and steering subsequent packets there.

**Accelerated RFS (aRFS)** is the good version: the kernel programs the *NIC's* flow-steering table (via `ndo_rx_flow_steer`) so the hardware delivers directly to the right queue — no IPI, no software steering, correct core from the first touch.

```bash
# aRFS requires ntuple filtering support
ethtool -K eth0 ntuple on
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
echo 2048  > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt
```

**But**: in a low-latency architecture you pin your handler thread to a known core and steer the flow there *explicitly* with a hardware n-tuple rule (§46.14). That is deterministic; RFS is adaptive and therefore variable, and it thrashes if the application migrates. **Explicit steering beats adaptive steering whenever you control both sides** — a good general principle to state.

### XPS

XPS maps CPUs to TX queues so that a thread transmits on a queue whose completion interrupt is affined to its own core. Without it, the TX queue is chosen by a hash and your completions land on some other core, migrating the skb and contending on that queue's qdisc lock (§46.2). With it, transmit is fully core-local: same core builds the skb, enqueues, rings the doorbell, and later reaps the completion — no shared cache lines. XPS is pure win with no latency cost, and configuring it is standard practice that many people forget.

---

## 46.14 Flow Steering

Where RSS hashes blindly, **flow steering** matches explicit rules — the `ethtool` n-tuple / Flow Director interface.

```bash
# Send all UDP traffic for the CME feed on port 14310 to RX queue 3
ethtool -N eth0 flow-type udp4 dst-ip 224.0.31.1 dst-port 14310 action 3
ethtool -n eth0                     # list installed rules
ethtool -N eth0 delete 1023         # remove by rule id
```

`action N` = deliver to queue N; `action -1` = drop (a hardware ACL, which is the cheapest possible packet filter — no PCIe transfer at all).

### The architecture it enables

```
NIC ──rule: group A → RXQ0 ──► IRQ0 → CPU2 (isolated) → feed handler A (pinned CPU2)
    ──rule: group B → RXQ1 ──► IRQ1 → CPU4 (isolated) → feed handler B (pinned CPU4)
    ──rule: order-entry TCP → RXQ2 ──► IRQ2 → CPU6 → gateway thread (pinned CPU6)
    ──default (everything else) → RXQ7 → CPU0 (housekeeping)
```

Every packet is processed, from DMA to application, on **one core, with one NUMA node's memory** (Ch. 29 §29.21), with no cross-core transfer and no adaptive component. This is the deterministic ideal for a kernel-path (non-bypass) trading host, and describing it end to end — hardware rule, queue, MSI-X affinity, isolated core, pinned thread, NUMA-local buffers — is close to a complete answer to "how would you architect a low-latency receive path without bypass?"

### Variants and limits

| Mechanism | Programmed by | Notes |
|---|---|---|
| `ethtool -N` n-tuple / Flow Director | Administrator, statically | Deterministic. Rule table is small (Intel: ~8k perfect-match, or hash-based "signature" mode with false positives) |
| aRFS | Kernel, automatically | Adaptive; follows the application (§46.13) |
| `tc flower` with `skip_sw` | `tc` | Hardware-offloaded classifier; richer matching, on capable NICs |
| Mellanox/NVIDIA steering rules via `devlink`/DPDK rte_flow | Application | Very expressive (inner headers, encapsulation) |
| **eBPF XDP** | Application | Runs *before* skb allocation; can redirect, drop, or pass (Ch. 47 §47.8) |

**Failure modes:** the rule table silently fills (`ethtool -N` returns `ENOSPC`, or worse, older drivers evict rules), Flow Director "signature" mode produces hash collisions that steer a flow to the wrong queue, and rules are lost across a link down/up or a driver reload — so they must be re-applied by a udev rule or a startup script. A steering rule that quietly disappeared, leaving a feed on the default queue and the housekeeping core, is a classic "we got slower and nothing changed" incident.

---

## 46.15 Per-Queue Interrupt Affinity

The final piece: binding each RX queue's MSI-X vector to a specific core.

```bash
grep eth0 /proc/interrupts                 # find the vector numbers per queue
echo 4 > /proc/irq/143/smp_affinity        # bitmask: CPU2
echo 2 > /proc/irq/143/smp_affinity_list   # or by list: CPU2
```

### Why it is not automatic

**`irqbalance` is the enemy.** The daemon periodically redistributes IRQ affinity to spread load, which for a trading host means your carefully placed queue interrupt migrates to a random core, possibly on the wrong NUMA node, mid-session. Standard practice: `systemctl disable --now irqbalance`, or at minimum `IRQBALANCE_BANNED_CPUS` covering the isolated cores. The diagnostic signature is a latency regression that appears minutes after boot and correlates with nothing in the application.

### The NUMA dimension

The NIC is attached to one CPU socket's PCIe root complex. DMA to memory on the *other* socket crosses the interconnect (UPI/Infinity Fabric), adding ~100–300 ns per access and consuming interconnect bandwidth (Ch. 29 §29.19). Everything must line up:

```
NIC PCIe slot  →  socket 0
RX ring buffers → allocated by the driver on socket 0 (driver honours dev_to_node())
IRQ affinity    → a core on socket 0
Application thread → pinned to that same core, socket 0
Application buffers, order book, pools → first-touched on socket 0 (Ch. 32 §32.26)
```

Check with:
```bash
cat /sys/class/net/eth0/device/numa_node     # -1 means the BIOS didn't report it — fix the BIOS
lstopo --of console                           # full topology including PCIe attachment
numactl --hardware
```

A `numa_node` of `-1` is common on misconfigured servers and means the kernel places buffers arbitrarily. Getting this wrong costs a consistent few hundred nanoseconds per packet and shows up as a NUMA-node-correlated latency difference between two supposedly identical handlers.

### Isolation stack

For a fully deterministic queue-to-core binding, the core must also be protected from everything else (Ch. 31 §31.19, Ch. 35 §35.16):

```
isolcpus=2-7 nohz_full=2-7 rcu_nocbs=2-7    # kernel cmdline
irqaffinity=0,1                              # all other IRQs to housekeeping cores
+ disable irqbalance
+ pin the queue's MSI-X vector to the handler core
+ SCHED_FIFO on the handler thread, or threaded NAPI at FIFO priority (§46.5)
+ THP off or preallocated (Ch. 35 §35.19)
```

**The subtlety:** with `nohz_full`, softirq processing on the isolated core is not free — the core still runs `NET_RX_SOFTIRQ` for its queue, which is what you want, but any *other* softirq work (timers, RCU callbacks) is a jitter source, which is what `rcu_nocbs` addresses. Threaded NAPI is attractive here because it turns softirq work into a schedulable, priority-controllable entity.

---

## 46.16 NIC and Kernel Packet-Drop Accounting

When packets go missing, the question is always *where*, and Linux exposes a drop counter at nearly every stage. Knowing which counter corresponds to which stage is one of the most practically useful things in this chapter.

```
wire → [NIC FIFO] → [DMA into ring] → [NAPI/softirq] → [protocol] → [socket queue] → app
          │              │                  │              │              │
   rx_fifo_errors   rx_no_buffer      softnet_stat     Ip/UdpInErrors  UdpRcvbufErrors
   rx_missed_errors rx_ring_full      col2 (dropped)   TcpInErrs       TcpBacklogDrop
```

### The tools

| Command | Shows |
|---|---|
| `ethtool -S eth0` | **Vendor-specific hardware counters** — the ground truth for NIC-level loss |
| `ip -s -s link show eth0` | Aggregate `RX: errors dropped overrun mcast` |
| `cat /proc/net/softnet_stat` | Per-CPU: processed, **dropped (backlog full)**, **time_squeeze**, backlog length |
| `nstat -az` / `netstat -s` | Protocol counters: `UdpRcvbufErrors`, `UdpNoPorts`, `TcpExtListenOverflows`, `TcpExtTCPBacklogDrop`, `IpInDiscards` |
| `ss -tim` | Per-socket `skmem ... d<drops>` — which *socket* dropped |
| `dropwatch -l kas` / `perf trace -e skb:kfree_skb` | **The exact kernel function that freed the packet** — the definitive answer |
| `bpftrace -e 'tracepoint:skb:kfree_skb { @[kstack] = count(); }'` | Same, aggregated by stack (Ch. 35 §35.21) |

Since kernel 5.17, `kfree_skb` carries a **drop reason** enum (`SKB_DROP_REASON_*`), so `perf trace -e skb:kfree_skb` prints e.g. `NOT_SPECIFIED`, `NO_SOCKET`, `SOCKET_RCVBUFF`, `TCP_CSUM`. This turned drop diagnosis from guesswork into a lookup, and citing it is a currency signal.

### Mapping symptoms to causes

| Counter rising | Meaning | Fix |
|---|---|---|
| `rx_missed_errors` / `rx_fifo_errors` | NIC's internal FIFO overflowed — the **PCIe/DMA path could not keep up**. Not a software problem. | Check PCIe link width (`lspci -vvv`), IOMMU mode, DDIO, competing devices on the same root port |
| `rx_no_buffer_count` / `rx_ring_full` | Driver did not refill the ring fast enough — **softirq starvation** | Larger rings, better IRQ affinity, threaded NAPI, isolate the core |
| `softnet_stat` col2 (dropped) | Per-CPU backlog full (RPS path) | Disable RPS, or raise `net.core.netdev_max_backlog` |
| `softnet_stat` col3 (`time_squeeze`) | NAPI ran out of budget — not a drop yet, but the precursor | Raise `netdev_budget`, reduce per-core load |
| `UdpRcvbufErrors` | **Socket receive buffer overflowed — the application is too slow** | Bigger `SO_RCVBUF` (bounded), faster handler, `SO_REUSEPORT` fan-out |
| `UdpNoPorts` | Nothing bound to that port — misconfiguration, or you joined the group but bound the wrong port | |
| `TcpExtListenOverflows` | Accept queue full (Ch. 45 §45.1) | Larger backlog, faster accept loop |
| `TcpExtTCPBacklogDrop` | Socket lock held by the app while packets arrived (§46.8) | Shorter time under the socket lock; larger `sk_rcvbuf` |
| Switch-side drops, nothing on the host | **Microburst exceeded the switch's egress buffer** (Ch. 39 §39.5) | Only visible on the switch; host counters are clean — a classic "we lost packets and Linux says everything is fine" |

**The diagnostic discipline to articulate:** loss is located by walking the counters outward from the application. If `UdpRcvbufErrors` is rising, the application is too slow and no NIC tuning will help. If `rx_no_buffer` is rising, the softirq is starved. If `rx_missed` is rising, the problem is below the driver — PCIe, IOMMU, or the card itself. And if every host counter is clean but sequence numbers show gaps (Ch. 37 §37.4), the loss is upstream on the network and you need switch counters or a passive tap with hardware timestamps (Ch. 48 §48.7).

**Silent-loss caveat:** counters are per-*device* and reset on driver reload, some vendors report the same drop in two counters (double counting), and `ip -s link`'s "dropped" is an aggregate that hides which stage. Always prefer `ethtool -S` for hardware and `kfree_skb` drop reasons for software. And note that **multicast loss is invisible without application sequence checking** — the kernel has no idea a datagram is missing, which is exactly why every market-data protocol carries a sequence number (Ch. 53 §53.4).

---

## Key Interview Questions

1. **Walk a packet from the wire to `recv()`.** — PHY → RSS queue selection → DMA into the RX ring → descriptor writeback + MSI-X → ISR schedules NAPI → softirq polls the ring and builds skbs → GRO → IP/UDP or TCP demux → socket lookup and enqueue → wake the reader → `copy_to_user`. ~5–15 µs, with a fat tail.
2. **Where does the time actually go?** — Roughly: 1–3 µs interrupt, 0.5–1 µs skb allocation and driver work, 0.5–1 µs protocol stack, 1–5 µs wakeup and context switch, 0.2–0.4 µs copy. The wakeup and the interrupt dominate, which is why busy polling wins so much.
3. **What problem does NAPI solve and how?** — Receive livelock: at 14.88 Mpps one IRQ per packet consumes all CPU. NAPI interrupts once, disables that queue's interrupts, and polls under a budget, re-enabling only when the ring drains.
4. **What is `time_squeeze`?** — `/proc/net/softnet_stat` column 3: NAPI exhausted its budget with work remaining, so processing is deferred, ultimately to `ksoftirqd` — a latency cliff.
5. **Why is `adaptive-rx` bad for trading?** — It varies interrupt delay with observed traffic, making your latency a function of other flows and producing a multi-modal distribution. Set `rx-usecs 0 rx-frames 1`.
6. **Why can bigger RX rings make things worse?** — A 4096-entry ring at 10 GbE holds ~5 ms of traffic, so overload becomes staleness instead of loss; and the ring's working set can exceed the DDIO L3 allocation, turning descriptor accesses into DRAM reads.
7. **Why is `sk_buff` expensive?** — Two allocations per packet, ~232 bytes across four cache lines plus `skb_shared_info`, touched by every layer; the metadata cache footprint, not the copy, is the dominant kernel cost. Contrast with DPDK's single-allocation `rte_mbuf`.
8. **What is `truesize` and why does it matter?** — Charged memory including skb and buffer overhead; a 64-byte datagram can be charged 2 KB, which is why `SO_RCVBUF` holds far less payload than expected.
9. **GRO versus LRO?** — LRO is irreversible hardware merging that breaks forwarding; GRO is reversible software merging in the NAPI poll, preserving GSO metadata. Both add latency; disable them on a feed interface.
10. **How does TSO hurt a latency-sensitive flow that does not even use it?** — A 64 KB TSO super-frame ahead of your small packet in the TX ring takes ~52 µs to serialize at 10 GbE, head-of-line-blocking your order. Argument for a dedicated NIC.
11. **Why does `tcpdump` show bad TX checksums?** — The capture tap runs before the NIC computes the checksum (`CHECKSUM_PARTIAL`).
12. **What is RSS and what is its most common misconfiguration?** — Hardware 4-tuple hashing into per-queue rings with their own MSI-X vectors. The classic bug is UDP hashed on IPs only, sending an entire multicast feed to one core; fix with `ethtool -N eth0 rx-flow-hash udp4 sdfn`.
13. **RSS, RPS, RFS, XPS — distinguish them.** — RSS = hardware RX steering; RPS = software RX steering via IPI (adds cost, rarely wanted); RFS = steer to the CPU where the app called `recvmsg`, with aRFS pushing the rule into hardware; XPS = pick the TX queue per CPU so transmit and completion are core-local.
14. **Why prefer explicit `ethtool -N` rules over aRFS?** — Determinism. You already pin the thread, so a static rule gives a fixed queue→IRQ→core→NUMA chain with no adaptive component to thrash.
15. **What does `irqbalance` do to you?** — Silently migrates your carefully affined queue IRQs, including across NUMA nodes, minutes after boot. Disable it.
16. **You are losing packets. How do you find out where?** — Walk outward: `ethtool -S` (`rx_missed` = PCIe/DMA, `rx_no_buffer` = softirq starvation), `/proc/net/softnet_stat`, `nstat` (`UdpRcvbufErrors` = slow application), `ss -tim` `skmem d` per socket, and `perf trace -e skb:kfree_skb` with drop reasons for the exact site. Clean host counters plus sequence gaps means upstream/switch loss.
17. **What is the socket backlog queue?** — Where softirq puts packets when the application holds the socket lock; the application then processes them on `release_sock`, migrating receive work into your syscall and adding latency variance.
18. **Why does TCP head-of-line blocking show up as a latency spike with no error?** — A gap strands later segments in `out_of_order_queue`; nothing is delivered until the retransmission arrives. Visible as `TcpExtTCPOFOQueue` and `retrans` in `ss -ti`.

---

## Common Traps

- **Assuming `send()` is a cheap queue push** — it runs the whole transmit path inline, including the MMIO doorbell write, in your thread.
- **Leaving `adaptive-rx`/`adaptive-tx` on** — nondeterministic, traffic-dependent latency.
- **Maximising ring sizes** — converts loss into staleness and blows the DDIO L3 allocation.
- **Leaving GRO/LRO on for market data** — adds microseconds and, for UDP GRO, delays the first datagram waiting for a second.
- **Leaving `irqbalance` running** — undoes all affinity work, silently.
- **Ignoring `/sys/class/net/eth0/device/numa_node == -1`** — buffers land on the wrong socket.
- **Using RPS on a modern multiqueue NIC** — adds an IPI and a cross-core cache transfer per packet for no benefit.
- **Forgetting UDP RSS hashing defaults to IP-only** — the entire feed lands on one core.
- **Not re-applying `ethtool -N` rules after link flap or driver reload** — steering silently reverts to default.
- **Assuming `tcpdump` is free** — it clones skbs, forces copies downstream, and changes the latency you are trying to measure.
- **Reading TX `tcpdump` checksums as errors** — they are computed later by the NIC.
- **Heavy TX interrupt coalescing** — delays completions, inflates `sk_wmem_alloc`, and stalls `send()` on an idle wire.
- **Sharing a NIC between bulk transfer and order entry** — TSO super-frames head-of-line-block your orders in the TX ring.
- **Single-queue qdisc on a multi-core sender** — global `qdisc` lock contention; use `mq`.
- **IOMMU in strict mode on a packet-rate host** — per-packet IOTLB invalidation.
- **Blaming the application when `rx_missed_errors` is rising** — that is a PCIe/DMA-level drop, below the driver.
- **Assuming clean host counters mean no loss** — switch-side microburst drops are invisible from the host; only sequence numbers reveal them.
- **`isolcpus` without `rcu_nocbs`/`nohz_full`** — residual timer and RCU work still jitters the isolated core.
- **Expecting `ip -s link` "dropped" to localise loss** — it is an aggregate; use `ethtool -S` and `kfree_skb` drop reasons.

---

## Compact Recall Summary

**Receive path.** Wire → NIC (RSS hash selects a queue) → DMA into the RX ring buffer (plus a descriptor writeback; DDIO puts both in L3) → MSI-X interrupt → ISR schedules NAPI and masks the queue's IRQ → `NET_RX_SOFTIRQ` polls the ring under a budget, allocating an `sk_buff` per frame → GRO → IP/L4 demux, netfilter, socket lookup → enqueue to `sk_receive_queue` (or `sk_backlog` if the app holds the socket lock) → wake the reader → `copy_to_user`. Total ~5–15 µs with a p99.9 tail of 50–200 µs; ~3 µs with busy polling, which removes only the interrupt and the wakeup.

**Transmit path.** `send()` runs inline: socket lock, `copy_from_user` into skbs, TCP header/window/Nagle decisions, route lookup, netfilter, qdisc enqueue/dequeue, driver descriptor fill, **MMIO doorbell write** (~200–1000 ns, the irreducible floor even in DPDK). ~1.5–4 µs. The skb is freed by the TX *completion*, so heavy TX coalescing inflates `sk_wmem_alloc` and stalls sends on an idle wire.

**Rings and interrupts.** Descriptor rings are shared circular arrays with a doorbell; two DMA transactions per packet. Small rings (512–1024) make overload appear as loss, not staleness. One IRQ per packet livelocks at 14.88 Mpps (67 ns/pkt vs 1–3 µs/IRQ); NAPI fixes it by interrupting once then polling to a budget, deferring to `ksoftirqd` when squeezed (`softnet_stat` col3). Coalescing (`ethtool -C`) trades first-packet latency for interrupt rate; `adaptive-rx` must be off. C-state exit adds 30–60 µs to the first packet after idle.

**sk_buff.** ~232 B over four cache lines plus a separate data buffer and `skb_shared_info`; two allocations per packet; `truesize` is the charged size and can be 32× the payload for small datagrams. Cloning (tcpdump, TCP retransmit queue) forces downstream copies. The metadata cache footprint — 8–15 lines per packet — is the real kernel cost, not the payload copy.

**Offloads.** Checksum offload is unambiguously good (removes a payload pass, no batching). GRO/LRO merge on receive — LRO is irreversible and forwarding-unsafe, GRO is reversible and flushes at the end of the NAPI poll; both cost microseconds, so disable them for feeds. GSO/TSO segment on transmit — 45× fewer stack traversals, but a 64 KB super-frame head-of-line-blocks small packets for ~52 µs at 10 GbE. `UDP_SEGMENT` is the UDP transmit-batching equivalent.

**Steering.** RSS = hardware Toeplitz hash over the 4-tuple into per-queue rings with per-queue MSI-X (check `ethtool -x/-n`; enable `sdfn` for UDP or one core takes the whole feed; symmetric keys make both directions land together). RPS = software steering via IPI, usually a pessimisation. RFS/aRFS = steer to the CPU where the app reads, with aRFS programming the NIC. XPS = per-CPU TX queue selection, pure win. Explicit `ethtool -N` flow rules give a deterministic group→queue→IRQ→core→NUMA chain, which beats anything adaptive when you pin threads.

**Affinity.** Bind each queue's MSI-X vector with `/proc/irq/N/smp_affinity`, disable `irqbalance`, and align NIC PCIe socket, ring buffers, IRQ core, application thread, and first-touched memory on one NUMA node (`/sys/class/net/*/device/numa_node`, `lstopo`). Layer on `isolcpus`/`nohz_full`/`rcu_nocbs`, threaded NAPI at `SCHED_FIFO`, and a housekeeping core for everything else.

**Drop accounting.** `ethtool -S`: `rx_missed`/`rx_fifo` = PCIe or NIC-internal, below the driver; `rx_no_buffer` = softirq starvation. `/proc/net/softnet_stat`: col2 backlog drops, col3 `time_squeeze`. `nstat`: `UdpRcvbufErrors` = the application is too slow, `TcpExtListenOverflows` = accept queue, `TcpExtTCPBacklogDrop` = socket lock held too long. `ss -tim skmem …d` = per-socket drops. `perf trace -e skb:kfree_skb` with 5.17+ drop reasons pinpoints the exact site. Clean host counters plus sequence gaps means upstream switch-buffer microburst loss.

**The motivation for Ch. 47.** Even perfectly tuned — RSS to an isolated core, no coalescing, no GRO, busy polling — the kernel path costs ~3–5 µs one way and carries a tail governed by scheduling. Two allocations, 8–15 metadata cache lines, a `copy_to_user`, a socket lock, and a general-purpose protocol stack per packet are structural, not tunable. Removing them requires removing the kernel from the data path entirely.
