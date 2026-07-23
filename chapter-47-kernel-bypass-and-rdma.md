# Chapter 47 — Kernel Bypass and RDMA

## Why This Matters — Core

Low-latency networking is not a contest to name the most specialized API. It is
a decision about who owns protocol work, packet memory, queues, wakeups, and
failure recovery.

A kernel socket provides a large contract: routing, TCP, permissions, fair
scheduling, observability, and cleanup after a process dies. Kernel bypass moves
some or all of the data path into user space. That can remove system calls,
copies, allocation, scheduler wakeups, and generic protocol work. It also makes
the application responsible for buffer lifetime, queue supply, polling cost,
device compatibility, and often part of the network stack.

RDMA goes further. A capable NIC can transfer between registered memory regions
and report completions without copying through ordinary socket buffers. With
one-sided operations, the remote CPU need not execute a receive operation at
all. The price is a distributed memory-access protocol whose keys, ordering,
credits, visibility, and recovery must be designed explicitly.

The durable mental model is:

```
choose semantics
      ↓
assign queue and buffer ownership
      ↓
make memory DMA-visible and isolated
      ↓
choose interrupt, adaptive wait, or polling
      ↓
post work → ring doorbell → device acts → consume completion
      ↓
measure the whole path, operate it, and retain rollback
```

Chapter 46 owns the Linux packet path and socket tuning. Chapters 28–29 own
caches, coherence, memory, and NUMA. Chapter 45 owns wire timestamps. This
chapter applies those ideas to bypass and RDMA; Chapter 48 examines NIC
architecture and measurement in more depth.

## 90-Second Screen — Core

Five facts:

1. **Bypass is a spectrum.** `PACKET_MMAP` removes repeated receive syscalls but
   remains in the kernel packet path; AF_XDP redirects packets through shared
   rings; a poll-mode driver can give user space direct queue control; a
   user-space socket stack preserves a socket-like API over a bypass path.
2. **Ownership is the correctness model.** A receive buffer is writable by the
   application only after a completion transfers ownership to it. Reposting or
   recycling it transfers ownership back. Early reuse causes corruption; late
   return causes starvation and drops.
3. **DMA is outside the C++ abstract machine.** `std::atomic` orders cooperating
   CPU threads, not arbitrary NIC DMA or MMIO. Use the driver/framework's DMA
   barriers and doorbell primitives and obey the NIC/provider contract.
4. **Zero-copy is a loan, not free memory.** It removes a copy and cache traffic
   only while the application accepts bounded buffer lifetime and backpressure.
   Retained data often should be copied into application-owned storage.
5. **RDMA completion is not application commit.** It has operation- and
   provider-specific meaning. A protocol still needs credits, record
   validation, notification, error epochs, and recovery.

Two decisions to defend:

- Which measured costs—system transitions, copies, wakeups, queueing, protocol
  work, or remote CPU work—justify leaving the socket path?
- Which component owns every buffer and queue entry at each step, and how does
  the design detect exhaustion, stale access, partial failure, and fallback?

## 47.1 Kernel-Bypass Motivation: A Change of Contract — Core

“The kernel is slow” is not a cost model. A normal receive can involve device
transfer, driver/NAPI work, packet metadata, protocol processing, socket
queueing, wakeup, and copying into an application buffer. Which parts occur
depends on the protocol, socket options, offloads, traffic rate, and Linux
version. A busy-polled UDP socket already has a different path from an
interrupt-driven TCP connection.

A first-order model for one delivered message is:

\[
T_{\text{message}} =
T_{\text{NIC+link}} + T_{\text{DMA}} + T_{\text{software path}} +
T_{\text{queue}} + T_{\text{wakeup}} + T_{\text{copy}} +
T_{\text{application}}
\]

Bypass can reduce terms in the middle; it cannot remove link serialization,
NIC pipeline work, PCIe/device transfer, or application parsing. It may increase
other terms through polling interference, batching delay, cache pollution, or
extra application-level protocol work.

### A More Useful Comparison

| Path | Data-path semantics | Commonly removed | What remains or moves to user space | Characteristic failure |
|---|---|---|---|---|
| Kernel sockets | TCP/UDP/IP and POSIX socket contract | Nothing by definition | Kernel owns protocol and socket queues | Scheduler or queue tail; kernel drops |
| `AF_PACKET` + `PACKET_MMAP` | Raw packet tap through a mapped ring | Per-packet receive syscall and copy into a `recv`-supplied buffer | Kernel still receives and populates the packet ring | Ring ownership held too long |
| AF_XDP | Raw frames redirected by XDP into UMEM rings | Much of the later stack; zero-copy when supported and requested | XDP policy, UMEM supply, ring management | Empty FILL ring; unintended copy/generic mode |
| Poll-mode/raw bypass | Raw device queues or a framework abstraction | Generic stack, wakeup, usually per-packet syscall/allocation | Protocol, polling, memory pools, queue recovery | Descriptor starvation or device/driver mismatch |
| User-space socket stack | TCP/UDP-like semantics over bypass | Kernel data path while preserving a higher-level API | Vendor/framework stack, polling, compatibility limits | Silent fallback or unsupported semantics |
| RDMA verbs | Message or remote-memory operations | Ordinary remote socket receive/copy; sometimes remote CPU work | Registration, keys, QPs/CQs, distributed protocol | Protection, credit, CQ, or QP failure |

None is the universally “fastest” choice. A small, bursty control service may
benefit more from sleepability, TCP maturity, and kernel tooling than from a
reserved polling core. A sustained raw-packet pipeline may make the opposite
trade. A venue-facing TCP connection cannot become RDMA unless the peer and
network support RDMA semantics.

### A Small Cost Ledger

Do not count only function calls. If a socket API receives \(B\) messages per
system call, its transition cost per message is approximately
\(C_{\text{syscall}}/B\), but batching can add wait time before the call returns.
A copy of \(N\) payload bytes contributes roughly \(N\) bytes of reads and
\(N\) bytes of writes, plus allocation and write-allocate effects. If metadata
of size \(M\) is scattered rather than co-located, the useful lower bound
\(\lceil(M+N)/L\rceil\) cache lines for line size \(L\) can substantially
understate actual lines touched. Measure them with the real allocator and
layout.

For a bounded queue, capacity must cover arrival bursts plus the interval for
which consumers retain ownership. A larger ring can absorb a longer stall, but
also hides overload for longer, consumes memory, and can enlarge worst-case
queueing delay. These mechanisms explain why “one fewer syscall,” “zero-copy,”
and “a deeper ring” are hypotheses rather than conclusions.

### Label Every Claim

Several layers are easy to mix:

| Label | Example |
|---|---|
| **C++23 guarantee** | `std::string_view` does not own or extend the lifetime of packet bytes |
| **Architecture/protocol** | A one-sided RDMA WRITE names a remote address and `rkey` |
| **Linux API** | AF_XDP uses RX/TX rings plus UMEM FILL/COMPLETION rings |
| **Framework** | A DPDK PMD exposes burst receive and transmit functions |
| **NIC/provider** | A particular driver supports AF_XDP zero-copy or inline send of a given size |
| **Vendor/version** | A named user-space socket stack supports a particular option in a documented release |
| **Measured** | Candidate B reduced p99.9 for replay corpus R on host class H |

Do not promote a measured result into an architectural guarantee. Conversely,
do not infer latency from an API diagram. The generated queue operations can be
correct while interrupts, NUMA placement, firmware, or a fabric pause dominates
the distribution.

## 47.2 Device Queues, Descriptor Ownership, and Completions — Core

A NIC queue is normally a bounded array of descriptors plus producer/consumer
state. A descriptor names a buffer and length and may carry offload or status
bits. The queue's exact layout is a NIC or provider ABI; applications usually
reach it through a driver or framework.

For receive, the application supplies empty buffers before packets arrive:

```
application                    NIC
    │  post empty buffer         │
    ├───────────────────────────▶│  owns buffer; may DMA into it
    │                            │
    │  completion(addr,len)      │
    ◀────────────────────────────┤  stops writing this completed buffer
    │  owns buffer; validate and parse
    │
    │  repost/recycle            │
    ├───────────────────────────▶│  owns it again
```

For transmit:

```
FREE → application builds frame → POSTED/device-readable
     → completion says safe-to-reuse → FREE
```

The completion is a lifetime event. It need not mean the peer consumed the
message, the packet reached the wire, or the transaction committed. Its exact
meaning depends on the operation and provider.

### Ownership State Machine

| State | Owner may read? | Owner may write? | Legal next step |
|---|---:|---:|---|
| Free application buffer | Application | Application | Prepare and post |
| Posted RX | Device/provider | Device/provider | Receive completion |
| Completed RX | Application | Application, subject to parsing contract | Parse, copy retained fields, repost |
| Posted TX | Device may read | Application must not mutate relevant bytes | Wait for completion |
| Completed TX | Application | Application | Reuse or free |

Two bugs produce very different symptoms:

- **Early reuse:** the application reposts an RX buffer while a parser retains a
  pointer, or modifies a TX buffer before completion. The result is
  load-dependent data corruption, often invisible to ordinary memory
  sanitizers because both agents legitimately access mapped memory.
- **Late return:** the application keeps many loaned buffers. The ring or pool
  runs out, so the device cannot receive, the API returns no descriptors, or
  drops rise. This is backpressure even if no mutex exists.

Encode identity in a cookie or `wr_id` and validate a generation in debug
builds. Count outstanding buffers. Alert before the queue reaches its hard
limit, not only after a drop.

### Publication to a Device

The abstract sequence for submitting work is:

```text
# Pseudocode: use provider APIs, not these names as portable functions.
write_payload_and_descriptor(slot)
provider_dma_write_barrier()
publish_producer_index_or_ring_doorbell()
```

CPU-to-CPU release/acquire is insufficient as a universal explanation. DMA
coherency, MMIO type, write combining, and required barriers are architecture,
OS, and device properties. A framework may hide all of this in its enqueue or
doorbell function. Adding a guessed `volatile`, `atomic_thread_fence`, x86
`sfence`, or Arm `dmb` is not a portable repair. Use the documented primitive,
then test on the supported architecture and NIC.

The reverse direction also requires the provider's completion-read protocol.
Some rings use phase bits so old entries can be distinguished after wraparound.
Some require a read barrier after observing ownership before reading descriptor
fields. Do not copy a ring algorithm without its memory-order contract.

## 47.3 Huge Pages, DMA Mapping, and IOVA Addressing — Core

A CPU normally issues virtual addresses. A device issues DMA transactions using
device-visible addresses. The software stack must establish the mapping:

```
application virtual address
        │
        │ CPU page tables
        ▼
physical pages
        ▲
        │ IOMMU mapping, when used
        │
device-visible I/O virtual address (IOVA)
```

With an IOMMU, the device can use an IOVA that the IOMMU translates to permitted
physical pages. This provides isolation and can make a virtually contiguous
range convenient for the device even when physical pages differ. Without an
IOMMU, a framework may use physical-address IOVAs and must satisfy the NIC's
scatter/gather and contiguity constraints directly.

Three requirements must not be conflated:

1. **Stable backing:** memory cannot disappear, migrate incompatibly, or be
   reclaimed while the device can access it.
2. **Device mapping and protection:** the device/provider can translate the
   submitted address, and access is limited to intended pages and permissions.
3. **Performance placement:** page size, TLB reach, NUMA node, alignment, and
   pool layout fit the workload.

Huge pages can improve TLB reach, reduce mapping metadata, and help frameworks
reserve large pools. They are not an architectural requirement for all DMA or
all DPDK configurations. Current behavior depends on DPDK memory mode,
IOVA-as-VA versus IOVA-as-physical-address, VFIO/IOMMU use, PMD requirements,
multi-process needs, and release. Ask the runtime for the chosen IOVA mode and
verify the driver documentation.

Similarly, “registered” does not always mean every page was eagerly pinned.
Classic RDMA registration commonly establishes translations and access keys for
resident memory; on-demand paging and device-memory mechanisms change the fault
and residency model. They trade setup cost for possible faults or different
failure behavior and require explicit provider support.

### Placement Checklist

- Allocate and register on the NUMA node local to the NIC and polling core when
  that topology is part of the performance model.
- Size RX pools from queue depth, maximum in-flight processing, bursts,
  headroom, and failure recovery—not from a copied default.
- Pre-touch memory if the deployment requires faults outside the hot path.
- Check locked-memory and cgroup/container limits before startup.
- Use an IOMMU/VF or another documented isolation boundary; do not grant a
  process unrestricted DMA merely to avoid setup work.
- Treat device reset and process death as lifecycle states: stop queues, revoke
  mappings/keys, and prove that DMA has quiesced before freeing memory.

Useful Linux diagnostics are read-only and version-sensitive:

```bash
# Examples only: names and output vary by kernel, driver, and deployment.
numactl --hardware
ip -details link show dev eth0
ethtool -i eth0
ethtool -S eth0
rdma link show
ibv_devinfo
```

Configuration belongs in an idempotent, tested deployment unit. Do not put
one-off device binding or huge-page writes into an interview answer as if they
were safe defaults.

## 47.4 Polling, Batching, and Zero-Copy — Core

### Busy Polling

Polling repeatedly reads completion state instead of sleeping for an interrupt
or event. Its benefit is conditional:

\[
T_{\text{interrupt}} =
T_{\text{interrupt moderation}} + T_{\text{wake/schedule}} + T_{\text{work}}
\]

\[
T_{\text{poll}} =
T_{\text{poll interval}} + T_{\text{work}} + T_{\text{interference}}
\]

A dedicated tight poll can reduce wakeup and scheduling variance, but consumes
CPU and power, competes for shared caches/memory bandwidth, and may affect
package frequency. A poll thread that also performs unbounded application work
can fail to replenish RX buffers or drive protocol timers.

An application may choose:

- interrupt-driven waiting for low duty cycle and resource efficiency;
- bounded busy polling followed by sleep for mixed workloads;
- permanent polling for a reserved, isolated, continuously valuable path.

The threshold is measured. Include idle power, neighboring workload, thermal
behavior, and overload—not only a single-flow median.

```cpp
// Framework-neutral pseudocode. poll(), repost(), and cpu_relax() are
// platform-specific; error and shutdown handling are deliberately explicit.
while (!stopping) {
    const auto batch = queue.poll(max_batch);
    if (batch.empty()) {
        cpu_relax();
        continue;
    }
    for (const Completion& c : batch) {
        if (!c.ok()) {
            record_queue_error(c);
            stopping = true;
            break;
        }
        const Frame frame = queue.borrow(c);
        process_in_place(frame);      // must not retain frame.data()
        queue.repost(c.buffer_id());
    }
}
queue.quiesce_and_drain();
```

This is intentionally pseudocode, not standard C++23: a real framework defines
the completion type, memory barriers, polling hint, and shutdown protocol.

### Batching

Batching amortizes descriptor checks, calls, and doorbells:

\[
C_{\text{per packet}} \approx C_{\text{work}} +
\frac{C_{\text{poll/enqueue}} + C_{\text{doorbell}}}{B}
\]

It can also delay the first item while a batch forms and enlarge the working
set. A burst API does not require waiting for a full burst: process what is
available when latency matters. Measure batch-size distributions and the time
from first arrival to action.

### What Zero-Copy Actually Saves

For a payload of \(N\) bytes, a copy adds approximately \(N\) bytes of reads and
\(N\) bytes of writes, plus write allocation or cache-management effects. It
also inserts another serial pass before parsing if the application waits for
the copy to finish.

Zero-copy receive lets the application parse a loaned DMA/ring buffer. The
benefit is often reduced cache traffic and earlier access, not merely fewer
instructions. Costs include:

- a fixed pool must absorb all outstanding loans;
- the buffer layout may be inconvenient or split across fragments;
- retaining a pointer couples application lifetime to queue capacity;
- DMA/CPU coherency and device synchronization remain platform concerns;
- mutable in-place parsing can destroy data needed by another consumer.

A strong policy is: parse headers and transient fields in place; copy only the
compact state that must outlive the callback; release the loan immediately.

## 47.5 Linux Shared-Ring Paths — Core

### `AF_PACKET` and `PACKET_MMAP`

`AF_PACKET` exposes link-layer packets on Linux. `PACKET_RX_RING` allocates a
kernel packet ring that user space maps; status fields transfer frames or
blocks between kernel and application ownership. `TPACKET_V3` groups frames
into blocks and supports a block-retirement timeout.

It removes a per-packet `recv` and the normal copy into a buffer supplied to
that call; user space reads the shared ring directly. It is not full kernel
bypass: the kernel driver and packet-socket path still participate and populate
the ring. This makes it a useful capture/replay option when kernel integration
and packet metadata matter more than minimum data-path work.

The key invariant is the status transition:

```
TP_STATUS_KERNEL ──kernel fills block──▶ TP_STATUS_USER
TP_STATUS_USER   ──application drains──▶ TP_STATUS_KERNEL
```

Exact flags and barriers are Linux UAPI details. Use the kernel's
`packet_mmap` documentation and a maintained library/example for the deployed
kernel. If user space holds a block, the kernel cannot recycle it.

### XDP and AF_XDP

XDP runs a verified eBPF program at an early Linux receive hook. Depending on
attachment mode and driver support, it can run in a native driver path, a
generic SKB path, or supported hardware offload. An XDP program can pass, drop,
transmit, or redirect a frame. Those action names describe Linux behavior, not
a universal NIC protocol.

AF_XDP sockets receive frames redirected through an XSK map into a registered
user memory area, **UMEM**. Four logical rings define ownership:

```
user → kernel/driver:  FILL addresses of empty UMEM frames
kernel/driver → user:  RX descriptors naming received frames
user → kernel/driver:  TX descriptors naming frames to transmit
kernel/driver → user:  COMPLETION addresses safe to reuse after TX
```

RX and TX rings belong to an XSK; FILL and COMPLETION are associated with UMEM
sharing rules. Ring producer/consumer rules are part of the Linux API and must
be obeyed. If FILL empties, receive has no buffer supply. If COMPLETION is not
drained, transmit frames cannot be recycled.

AF_XDP has copy and zero-copy operation. Zero-copy requires support from the
driver/NIC path. A program that requires it should request the corresponding
bind mode and fail deployment if it is unavailable, rather than silently
benchmarking a fallback. The `need_wakeup` contract can require a syscall to
restart RX or TX processing; “AF_XDP means no data-path syscalls” is therefore
not a safe universal claim.

AF_XDP is a strong candidate when per-queue diversion, XDP filtering, and
retaining the kernel network device/tooling are valuable. Validate the actual
attachment mode, zero-copy mode, queue steering, and counters for the named
driver and kernel.

## 47.6 DPDK Poll-Mode Drivers and Huge-Page Memory — Core

DPDK is a user-space packet-processing framework with poll-mode drivers (PMDs),
packet buffers, memory pools, rings, and supporting libraries. Its Ethernet API
is burst-oriented:

```c
/* DPDK API excerpt; setup, errors, ownership metadata, and TX omitted. */
struct rte_mbuf* packets[32];

for (;;) {
    const uint16_t n = rte_eth_rx_burst(port_id, queue_id,
                                        packets, RTE_DIM(packets));
    for (uint16_t i = 0; i < n; ++i) {
        if (rte_pktmbuf_is_contiguous(packets[i]))
            handle_packet(rte_pktmbuf_mtod(packets[i], const void*),
                          rte_pktmbuf_pkt_len(packets[i]));
        else
            handle_segmented_packet(packets[i]);
        rte_pktmbuf_free(packets[i]);
    }
}
```

This is framework-specific C, not standard C++ and not a complete application.
The PMD owns descriptors; each returned `rte_mbuf` is application-owned until
freed or transmitted. Multi-segment packets require walking segments rather
than assuming one contiguous payload.

DPDK can remove generic socket/protocol work and make allocation a pool
operation. It does not promise zero copies, a fixed descriptor format, a
specific latency, or that every driver behaves identically. A PMD may require
particular queue alignment, offload flags, burst sizes, or cleanup calls.

### Device and Memory Choices

On Linux, DPDK deployments commonly use VFIO so a process can operate an
assigned PCI device with IOMMU isolation. Binding a device or VF changes its
kernel-driver ownership and can remove normal network-interface behavior for
that function. Resolve the exact PCI function first; never experiment on a
management interface.

DPDK commonly uses explicit huge-page-backed memory, but its current memory
subsystem also has dynamic/legacy modes and a `--no-huge` option whose
compatibility depends on IOVA mode and PMD. Explain the requirements of the
chosen configuration rather than memorizing “DPDK requires huge pages.”

### Cost and Failure Model

Expected gains:

- preallocated packet metadata and payload pools;
- polling instead of interrupt/wakeup;
- burst amortization;
- direct flow steering and queue affinity;
- fewer generic stack branches and cache touches.

Added costs:

- dedicated cores, reserved memory, and possibly exclusive device/VF ownership;
- raw Ethernet/IP/UDP/TCP responsibility unless another stack is used;
- offload and descriptor differences across PMDs/NICs;
- replacement observability and reset/recovery;
- upgrade qualification across application, DPDK, PMD, firmware, and NIC.

Measure end-to-end behavior with the intended PMD and firmware. A framework
microbenchmark cannot establish application p99, loss under overload, or safe
recovery after a port reset.

## 47.7 User-Space Stacks and Product Families — Reference

*Skippable on a first pass. Names, ownership, licensing, device support, APIs,
and feature matrices change. Verify the vendor documentation and exact release;
do not treat this section as a purchasing recommendation.*

| Family | API shape | Main value | Main constraint to verify |
|---|---|---|---|
| OpenOnload | POSIX-socket acceleration/interposition | Small application change; user-space TCP/UDP path on supported AMD/Solarflare environments | Which sockets/options are accelerated; fallback observability |
| `ef_vi` | Low-level virtual-interface queues/events | Raw-frame control and small poll path | Supported NIC/driver, filtering, memory registration, protocol responsibility |
| TCPDirect | Non-POSIX user-space TCP/UDP API | Explicit reactor and zero-copy-oriented interfaces | Feature set, threading model, hardware/release compatibility |
| VMA/XLIO family | Socket acceleration on supported NVIDIA networking stacks | Socket API with accelerated data path | Current product name/support matrix and whether a socket actually offloads |
| DPDK-based or other user-space TCP/IP stacks | Framework-native API | Protocol semantics over poll-mode queues | TCP completeness, timer progress, interoperability, maintenance ownership |

The transferable mechanism is more important than the brand:

1. a control path allocates queues, installs filters, and maps/registers memory;
2. a data-path thread polls a user-visible queue;
3. a user-space protocol stack handles state, retransmission, timers, and socket
   compatibility to the extent promised;
4. unsupported operations may fail or fall back, depending on the product.

Fallback is safe only if it is observable and meets the contract. At startup and
during canary deployment, prove which sockets/queues are accelerated. Record
vendor stack, kernel driver, firmware, NIC identity, environment/configuration,
and fallback counters.

### Build or Buy the Protocol?

UDP receive/forwarding can be narrow: validate Ethernet/IP/UDP, handle
fragmentation policy, multicast membership/control, checksums/offloads, and
loss/sequence recovery. TCP adds connection state, congestion behavior,
retransmission, ACK/window processing, timers, stream reassembly, and
interoperability. A poll thread that stops driving a user-space stack can delay
ACKs and timers.

That does not prove “never build TCP.” It establishes the burden of proof.
Choose a maintained stack unless a constrained protocol, measurable advantage,
and failure-test program justify ownership. The rollback path is usually the
existing socket implementation behind the same application interface.

## 47.8 RDMA Transport and Programming Model — Core

Remote Direct Memory Access is a family of transport and device operations, not
synonymous with “zero-copy sockets.” The verbs API exposes objects commonly
including:

- **context/device:** an opened RDMA-capable device;
- **protection domain (PD):** groups resources into a protection boundary;
- **memory region (MR):** a registered address range with access flags, local
  key (`lkey`), and, when remote access is allowed, remote key (`rkey`);
- **queue pair (QP):** send queue plus receive queue with transport state;
- **completion queue (CQ):** records completion of selected work;
- **shared receive queue (SRQ):** optional receive-buffer pool shared by QPs.

The ordinary submission path is:

```
application fills registered buffer
        ↓
posts work request (WR) containing scatter/gather entries
        ↓
provider creates/updates work queue entry (WQE)
        ↓
doorbell notifies NIC
        ↓
NIC transfers data according to transport and access rights
        ↓
completion queue entry (CQE), if the operation generates one
        ↓
application polls CQ and checks status + wr_id
```

Verbs names and structures are Linux/rdma-core APIs. WQE/CQE layout, inline
limits, queue capacities, and acceleration are provider/NIC details.

### Minimal Verbs-Style Completion Loop

```c
/* Linux libibverbs excerpt. QP/MR/CQ setup and recovery are omitted.
   The receive buffers are registered and were posted with wr_id = slot. */
struct ibv_wc wc[16];

for (;;) {
    int n = ibv_poll_cq(cq, 16, wc);
    if (n < 0)
        fail_cq();
    for (int i = 0; i < n; ++i) {
        if (wc[i].status != IBV_WC_SUCCESS) {
            fail_qp(wc[i].qp_num, wc[i].status, wc[i].vendor_err);
            continue;
        }
        consume_slot(wc[i].wr_id, wc[i].byte_len);
        repost_receive(wc[i].wr_id);
    }
}
```

Polling removes event-channel wakeup but consumes a core. Event-driven CQ
notification remains useful for low-duty paths. Event APIs have arm/drain
protocols to avoid missed events; follow the provider example rather than
inventing a check-then-sleep sequence.

## 47.9 RDMA Memory Registration, Pinning, and Memory Regions — Core

Registration tells the provider which memory the device may access and under
which rights. A successful MR supplies:

- `addr` and length: the registered range;
- `lkey`: authorizes local scatter/gather entries;
- `rkey`: capability a peer presents for permitted one-sided access;
- flags: local write and selected remote read/write/atomic permissions.

An `rkey` is not a business authorization or encrypted token. Anyone with
network reach, the correct transport context, address, and valid key may obtain
the allowed device access. Minimize region size and permissions, distribute
keys only through authenticated control channels, isolate tenants with PD/QP
and network controls, and rotate/revoke access by a documented lifecycle such
as memory-window rebinding or MR teardown after quiescence.

Registration is commonly too expensive and stateful for a per-message hot
path. It can pin/map pages, populate NIC translation state, and consume device
resources. Exact work is provider and mode dependent. Typical strategy:

1. allocate bounded pools during initialization on the intended NUMA node;
2. register a small number of regions with least privilege;
3. suballocate fixed slots and use generation/epoch metadata;
4. keep keys stable only for the connection epoch;
5. stop new work, drain outstanding WRs, revoke remote access, then deregister.

Do not free, unmap, or repurpose memory while a local or remote operation can
still reference it. Process `fork`, copy-on-write, containers, on-demand paging,
and GPU/device memory all have provider-specific rules. Treat them as explicit
deployment requirements, not incidental POSIX behavior.

### Capacity Model

Registered bytes are not the only resource:

\[
\text{required slots} \ge
\text{arrival rate} \times \text{maximum ownership time}
+ \text{burst/recovery margin}
\]

Also budget MR entries, QP work requests, CQ entries, receive credits, memory
translation cache pressure, and locked-memory limits. A large “register the
heap” region may reduce setup calls while expanding remote blast radius and
translation footprint.

## 47.10 RDMA Queue Pairs, Completion Queues, and Credits — Core

Posting succeeds only while the send queue has capacity. SEND-based traffic
also needs a receive WQE at the peer. The remote peer therefore grants credits
by posting receive buffers or advertising a higher-level count. If a SEND
arrives without a valid receive under a transport that requires one, the result
is not an elastic kernel socket queue.

Completions reclaim resources and report errors. A work completion contains a
`wr_id`, status, opcode, and operation-specific fields. Use `wr_id` to identify
the buffer or transaction; do not infer identity solely from an array position
or from completions on another QP.

Signaling every send can increase CQ traffic. Signaling only selected sends can
amortize CQEs, but the application must prove which earlier unsignaled buffers
become reclaimable when a later signaled WR completes, and must signal often
enough to avoid exhausting the send queue. This proof depends on transport and
provider ordering.

A CQ is bounded. If software does not drain it fast enough, overrun can make
the CQ unusable and trigger an asynchronous error. Record the first failure,
QP/CQ identity, provider syndrome, outstanding WR range, and connection epoch.
Later flushed completions are often consequences rather than root causes.

### Transport Shapes

| QP/transport shape | Operations | Reliability/order | Typical use |
|---|---|---|---|
| Reliable Connected (RC) | SEND/RECV, RDMA READ/WRITE, supported atomics | Reliable connected transport with defined per-QP ordering, subject to operation/access flags | Stateful messaging and one-sided access |
| Unreliable Connected (UC) | SEND/RECV and RDMA WRITE in common verbs semantics | Connected but not retransmitted; feature set is narrower | Specialized loss-tolerant paths |
| Unreliable Datagram (UD) | SEND/RECV datagrams | Message boundaries; delivery/order not guaranteed | Multicast or scalable connectionless messaging |

Capability queries are authoritative. Do not infer atomic scope, inline size,
maximum scatter/gather entries, or queue depth from the transport name.

## 47.11 One-Sided and Two-Sided RDMA — Core

### Two-Sided SEND/RECV

The sender posts SEND; the receiver must have posted RECV. Both sides observe
completions according to their signaling/notification choices. This is a
message-passing model with explicit receive-buffer credits. It naturally wakes
or engages the remote application and is often the simpler design for commands,
RPC, and variable ownership.

### One-Sided Operations

- **RDMA WRITE:** sender places bytes into an authorized remote region.
- **RDMA READ:** sender fetches bytes from an authorized remote region.
- **RDMA atomic:** supported operations update a remote location under
  device-defined atomicity, alignment, and scope rules.

The remote CPU need not post a matching receive for a plain one-sided READ or
WRITE and may not receive a CQE. That saves remote work but creates a
notification problem. Common protocol patterns include a WRITE with immediate
data that consumes a posted receive and produces a remote completion, or
separate data and notification operations with ordering guaranteed by the
chosen transport/provider contract.

Do not assume:

- bytes inside a large transfer become CPU-visible in address order;
- operations from different QPs are globally ordered;
- relaxed-ordering MRs preserve write-after-write arrival order;
- a local completion means a remote application consumed or persisted data;
- NIC atomics interoperate with CPU `std::atomic` on the same location.

Those are separate architecture/provider/platform questions. Design around a
documented completion point, and use sequence numbers, lengths, checksums, and
epochs so readers reject torn, stale, or replayed records.

## 47.12 InfiniBand and RoCE — Core

InfiniBand defines its own link/fabric architecture with subnet management,
addressing, and credit-based flow control. RoCE carries RDMA transport over
Ethernet: RoCEv1 is link-layer scoped; RoCEv2 uses UDP/IP encapsulation and can
be routed. These are protocol facts. Achieved loss, congestion behavior,
latency, and failover are fabric measurements.

RoCE does not imply one universal PFC configuration. Deployments may use
lossless classes with Priority Flow Control (PFC), lossy/semi-lossless designs
with ECN-based congestion control, or vendor-specific combinations. PFC can
reduce drops but can also cause head-of-line blocking, congestion spreading,
or deadlock when the topology and buffer dependencies are wrong. ECN and the
endpoint congestion-control algorithm must be configured consistently across
NICs and switches.

Validate:

- MTU, VLAN/priority mapping, ECN marking, and congestion-control mode;
- PFC per-priority pause counters if PFC is enabled;
- retransmission, congestion notification, discards, and link errors;
- route symmetry and failover behavior for RoCEv2;
- firmware/provider compatibility and time synchronization for measurement.

RDMA is a peer-and-fabric decision. If an external venue speaks ordinary
Ethernet UDP/TCP, an internal RDMA NIC cannot change that endpoint's protocol.
RDMA commonly fits controlled internal replication, storage, RPC, or fan-out
where both endpoints and the network are under one operational contract.

## 47.13 Worked Decision: Kernel Socket or Bypass? — Core

A feed process receives UDP datagrams, validates sequence numbers, updates a
book, and occasionally sends a gap request over TCP. The target is end-to-end
decision p99.9 under the production burst distribution, with zero unreported
drops. The fleet uses two NIC families, and operations requires remote capture
and a rollback within one deployment window.

### Step 1: Measure and Attribute

Retain packet hardware/software timestamps where trustworthy, application
timestamps, CPU samples, wakeups, socket drops, NIC queue counters, and
sequence gaps. Sweep normal rate, opening burst, malformed packets, and a
deliberate consumer stall.

Suppose the experiment—not a universal benchmark—finds:

- interrupt-driven sockets miss the tail target and slow samples correlate
  with wakeups;
- kernel busy polling meets the target on one host class but has little
  headroom during bursts;
- copying payloads is a small part of total decision time;
- loss begins when the application stalls, regardless of API;
- only one NIC family supports the required AF_XDP zero-copy path.

This evidence says wakeup and queue headroom matter. It does not say that
removing every copy or adopting a raw PMD must win.

### Step 2: Compare Bounded Candidates

| Candidate | Expected mechanism | New cost | Falsifier | Rollback |
|---|---|---|---|---|
| Tuned socket + bounded busy poll | Reduce wake/schedule delay | CPU/power; kernel path remains | Tail still tracks wakeups or burst drops | Restore wait policy |
| AF_XDP on selected RX queue | Skip later stack, explicit UMEM supply | Raw-frame path; driver support split | Copy/generic mode, FILL starvation, no tail gain | XDP PASS to socket path |
| DPDK on dedicated VF/port | Direct PMD queue and pools | Device ownership, new protocol/tooling | Operational or cross-NIC burden exceeds gain | Reattach/use parallel socket interface |
| User-space socket stack | Preserve TCP/UDP-like API over bypass | Vendor/release dependency; fallback risk | Required options not accelerated | Launch without interposition |

Start with the least disruptive candidate predicted to meet the contract. If
kernel busy polling passes with burst headroom, that may be the production
answer. If not, test AF_XDP on the supported host while retaining the socket
implementation behind the same parser interface. DPDK is justified only if its
incremental distribution or capacity gain pays for device and protocol
ownership.

### Step 3: Test Ownership and Failure

For each bypass candidate:

1. stop reposting RX buffers and verify a visible starvation/drop alarm;
2. delay processing and prove the sizing model;
3. force queue/link reset and exercise quiesce, drain, and reinitialization;
4. test malformed and multi-buffer frames;
5. prove capture/sequence-gap observability;
6. record mode, driver, firmware, queue steering, CPU/NUMA placement, and raw
   latency samples.

Ship only on supported combinations through a canary. Route or pass traffic to
the socket path when health checks fail if the protocol permits safe handover.
Rollback is part of the design, not an admission that bypass was unnecessary.

## 47.14 Worked RDMA Design: Hot-Standby Replication — Core

A primary must replicate fixed-size risk snapshots to a standby. The standby
must detect a complete new snapshot, reject stale data after reconnect, and
take over only after an external fencing decision. The requirement is not
“use one-sided RDMA”; it is bounded replication lag with correct failover.

### Data and Control Planes

Allocate a small registered ring of slots per peer:

```text
slot = { epoch, sequence, payload_length, payload, checksum }
control = { negotiated epoch, slot count, keys, credits, health }
```

Use an authenticated control connection to exchange QP parameters, the minimal
remote address/key, epoch, and capacity. Never expose unrelated heap memory.
On reconnect, allocate or rekey a new epoch so delayed operations from an old
connection cannot be accepted as current.

For each snapshot, the primary chooses a free slot and posts an
`RDMA_WRITE_WITH_IMM` or another provider-documented data-plus-notification
sequence on one RC QP. The standby maintains the required posted receives for
immediate notifications. On successful receive completion it:

1. identifies the slot and epoch from bounded metadata;
2. validates length, sequence, and checksum;
3. publishes the snapshot to local readers using an ordinary CPU
   synchronization protocol;
4. returns a credit through the control protocol.

The CQE is the chosen **data-visible validation point**, subject to the exact
provider/MR ordering mode. It is not a failover commit and not durable storage.

### Why the Obvious One-Sided Ring Can Be Wrong

A tempting design lets the primary overwrite `write_index` and slots while the
standby polls memory, with no completion or credit protocol. It appears to
remove remote CPU work. It fails because:

- the standby may observe notification without a documented visibility point;
- the primary can lap the reader and overwrite a live slot;
- reconnect can replay an old index or `rkey`;
- one lagging standby can exhaust shared resources;
- no CQ signal means transport errors may be noticed too late;
- remote memory arrival does not fence which machine is allowed to act.

For modest update rates, two-sided SEND/RECV may be the better design: it gives
natural credits and receiver completions with less custom metadata. One-sided
is justified when remote CPU savings or transfer shape is measured and the
added protocol has been failure-tested.

### Capacity and Recovery

Let \(R\) be the peak snapshot rate, \(L\) the allowed interval before a slot
credit returns under a slow-but-healthy standby, and \(B\) a burst/recovery
margin:

\[
\text{slots per standby} \ge \lceil R L \rceil + B
\]

Measure the distribution of credit-return time, not only average network RTT.
When credits run out, choose an explicit policy: block primary publication,
coalesce snapshots while preserving sequence meaning, or mark the standby
unhealthy and trigger a higher-level recovery. Never silently overwrite.

On QP/CQ error, stop posting, capture the first error and outstanding sequence
range, fence the old epoch, drain/destroy resources in provider order, then
reconnect and resynchronize from an application checkpoint. RDMA reconnect is
not state recovery by itself.

## 47.15 Deployment and Decision Framework — Core

Use this decision order:

```
Does the peer require TCP/ordinary UDP?
 ├─ yes → can tuned sockets meet the measured contract?
 │        ├─ yes → keep sockets
 │        └─ no  → test user-space socket stack or raw bypass + owned protocol
 └─ no / both endpoints controlled
          ↓
Is raw packet processing or remote-memory/message semantics the better fit?
 ├─ raw packet → AF_XDP / PMD / vendor queue API, chosen by operability
 └─ RDMA       → two-sided first; one-sided when remote CPU/transfer evidence pays
```

Before production, fill a ledger:

| Dimension | Required evidence |
|---|---|
| Semantics | TCP/UDP/raw/RDMA operation, ordering, delivery, fragmentation and failure contract |
| Workload | Message sizes, flows, burst distribution, working set, idle duty cycle |
| Correctness | Ownership assertions, sequence/checksum, credit limits, reconnect epochs |
| Platform | CPU/NUMA, NIC, firmware, driver/provider, kernel/framework versions |
| Performance | p50/p99/p99.9 as required, throughput, drops, queue depth, CPU/power |
| Operations | Counters, capture, reset, link flap, process crash, rolling upgrade |
| Security | IOMMU/VF boundary, PD/MR permissions, key exchange/revocation |
| Rollback | Parallel socket/control path, XDP PASS, device rebind procedure, data resync |

Measure at the application boundary and, where available, with independent
wire/NIC timestamps. Track queue occupancy, empty-buffer events, CQ errors,
NIC/fabric discards, retransmissions/congestion signals, and sequence gaps.
CPU utilization alone is misleading for a deliberate poll loop.

Upgrade one layer at a time. Qualify the matrix of firmware, driver/provider,
kernel, framework, and application because ownership or offload behavior can
change at their boundaries. Canary under real traffic shape, then rehearse
rollback while the old path still works.

## 47.16 Common Traps — Core

- Saying “kernel bypass” without naming which kernel work remains.
- Comparing vendor latency numbers collected with different packet sizes,
  topology, timestamps, load, or percentiles.
- Assuming bypass removes NIC, PCIe, serialization, or application costs.
- Treating huge pages as mandatory for every DMA/DPDK configuration, or as a
  substitute for IOMMU isolation.
- Mapping a management device into a user process without a verified recovery
  channel.
- Publishing descriptors with C++ atomics or `volatile` while ignoring the
  provider's DMA/MMIO barrier contract.
- Reusing a TX buffer before completion or retaining an RX loan until the pool
  starves.
- Assuming one contiguous packet when the API permits multiple segments.
- Waiting to fill a burst and thereby adding queueing latency.
- Busy polling without measuring power, neighboring cores, thermal behavior,
  overload, and the work required to drive protocol timers.
- Calling `PACKET_MMAP` full bypass.
- Benchmarking AF_XDP without proving native/driver mode and requested copy or
  zero-copy behavior.
- Forgetting the AF_XDP FILL or COMPLETION ring, or the `need_wakeup` contract.
- Assuming a user-space socket was accelerated because the process launched
  successfully.
- Writing a TCP stack because the steady-state receive path looks small while
  omitting timers, retransmission, reassembly, congestion, and recovery.
- Registering memory per message or exposing one enormous remotely writable MR.
- Treating an `rkey` as authentication.
- Posting SENDs without peer receive credits.
- Failing to drain a CQ, or treating later flushed completions as independent
  root causes.
- Assuming completion means peer consumption, durability, or business commit.
- Assuming cross-QP ordering, byte-order visibility within an in-flight write,
  or CPU/NIC atomic interoperability without a documented guarantee.
- Reusing RDMA slots without sequence, epoch, and bounded credits.
- Declaring that RoCE universally requires PFC, or enabling PFC without testing
  head-of-line blocking, pause propagation, and failure containment.
- Treating reconnect as application resynchronization or network reachability
  as authority to act.

## 47.17 Recall and Practice — Core

### Recall Card

- Bypass trades kernel services for direct ownership of queues, memory,
  polling, protocol work, observability, and recovery.
- Model NIC/DMA, software, queue, wakeup, copy, and application costs
  separately.
- Receive ownership is posted → device-owned → completed/application-owned →
  reposted. Transmit memory is immutable until safe-to-reuse completion.
- Device DMA and MMIO ordering use provider/architecture rules, not the C++
  memory model alone.
- Huge pages, IOVA mode, pinning, NUMA placement, and IOMMU isolation answer
  different questions.
- `PACKET_MMAP` removes repeated syscalls/copies but remains a kernel packet
  path; AF_XDP uses UMEM with FILL/RX/TX/COMPLETION rings.
- Polling buys wakeup predictability with a core, power, thermal, and fairness
  budget. Batching amortizes overhead but can add first-item delay.
- Zero-copy is a bounded loan. Copy retained fields and return queue buffers
  promptly.
- DPDK supplies PMDs, pools, rings, and burst APIs; it does not supply universal
  latency, protocol semantics, or identical NIC behavior.
- An RDMA MR grants bounded device access through `lkey`/`rkey`; QPs submit
  work, and CQs report selected completions and errors.
- Two-sided SEND/RECV has explicit receive credits. One-sided operations reduce
  remote CPU work but need notification, validation, credits, and epochs.
- InfiniBand and RoCE are different fabrics; PFC/ECN choices are deployment
  contracts, not slogans.
- Ship against an exact platform matrix, canary, observe queue failure, and
  keep a tested socket/resynchronization rollback.

### Reasoning Questions

1. A socket receiver misses p99.9 only after idle periods. Which terms in the
   cost model would you measure before proposing DPDK?
2. Draw the ownership transitions for one AF_XDP UMEM frame used for RX and
   then TX. At which points may the application modify it?
3. Why can a C++ release store be insufficient before ringing a NIC doorbell?
4. When can copying a 32-byte parsed record out of a loaned 2 KiB RX frame
   improve system capacity despite adding a copy?
5. Which observations distinguish AF_XDP copy mode, zero-copy mode, and generic
   XDP attachment in a deployment review?
6. A PMD loop has low median latency but loses packets during a 200-microsecond
   application stall. Build a queue-depth model and name two valid responses.
7. Compare two-sided SEND/RECV with one-sided WRITE for commands that require a
   remote service to execute logic immediately.
8. A successful local RDMA WRITE completion arrives. Which conclusions about
   remote visibility, application consumption, persistence, and business
   commit require separate guarantees?
9. Why can a huge remotely writable MR improve setup simplicity while worsening
   both security and translation/resource behavior?
10. RoCE p99 regresses while means remain stable and pause/congestion counters
    rise. Which host and switch evidence would you correlate before changing
    PFC or ECN?

### Code-Reading Puzzle

```cpp
// Pseudocode: assume rx.data points into a device-managed receive pool.
void on_receive(RxQueue& q) {
    auto rx = q.poll_one();
    if (!rx) return;

    pending.push_back(
        std::string_view{rx.data + rx.header_bytes, rx.payload_bytes});
    q.repost(rx.buffer_id);
}
```

The consumer reads `pending` later. Under light load it works; under burst load
strings change or fail parsing. Explain why the C++ objects can all be
well-formed while the protocol is wrong. Give two repairs and compare their
copy, memory, and queue-capacity costs.

### Applied Exercise

Choose either a packet receiver or an RDMA replication path. Write:

1. the workload, semantic contract, and required distribution;
2. a queue/buffer ownership diagram;
3. a cost model for syscalls, copies, wakeups, queueing, cache traffic, or
   remote CPU work;
4. two candidate paths, each with condition, expected mechanism, added cost,
   falsifier, and rollback;
5. a failure test for starvation, reset, stale epoch, and overload;
6. the platform/version matrix and counters needed to operate it.

Do not choose the technology until the model predicts which term should move.

### Prerequisites for Chapter 48

Chapter 48 assumes you can distinguish protocol semantics from Linux,
framework, provider, NIC, and measured behavior; trace descriptor and buffer
ownership; explain DMA mapping and completions; and state what a latency
timestamp does and does not include. It builds on that foundation to examine
NIC queues, offloads, SmartNICs/FPGAs, capture, clock domains, and measurement
error.
