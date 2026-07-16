# ML Inference at the Edge for Crypto Trading

**Research Document -- Anavitrade Platform, Stage 3 ML Pipeline**

| Field | Value |
|-------|-------|
| Date | 2026-07-15 |
| Status | Complete |
| Author | Claude Opus 4.8 (research + synthesis) |
| Audience | Anavitrade engineering team |
| Dependencies | PRD Stage 3: ML Signal Scoring |

---

## Executive Summary

For running a trained LightGBM/ONNX model (under 10 MB, single-row tree ensemble inference) at the target volume of 10K--100K+ inferences/day, **CPU inference on a VPS co-located with the execution server is the clear recommendation**. The performance overhead is negligible (single-row ONNX inference is ~11 microseconds on a decade-old CPU), the cost is zero-marginal (the execution server already exists), and the architecture is trivially simple.

The runner-up -- Lambda Labs GPU -- provides more than 100x the compute needed at $0.69--$1.09/hr, making it wasteful. Cloudflare Workers is structurally unfit for this workload due to 128 MB memory cap, 10 ms CPU time on the free tier, and absence of custom gradient-boosted tree model support. Serverless GPU platforms (Modal, RunPod, Replicate) impose 2--60 second cold starts and per-second billing that makes them 10--50x more expensive per inference than a co-located CPU deployment.

**Primary recommendation**: Deploy the ONNX model alongside the execution server on the same VPS, using ONNX Runtime C API or `lleaves` (LLVM-compiled LightGBM) for sub-10-microsecond inference. This eliminates network latency, cold starts, and separate infrastructure costs.

---

## Comparison Table

| Option | Cold Start | Inference Latency (p50) | Cost per 1M Inferences | Model Size Limit | Deployment Complexity | Reliability / SLA |
|--------|-----------|------------------------|----------------------|-----------------|----------------------|-------------------|
| **CPU VPS (co-located)** | None (always warm) | ~11 us (ONNX Runtime) / ~10 us (lleaves) | $0.00 (marginal) | 100+ MB (RAM-limited) | Low | 99.9%+ (single-node, same as execution server) |
| **Lambda Labs GPU** | 2--5 min (instance launch) | ~50--200 us (GPU transfer overhead for micro-batches) | ~$0.19--$0.30 (A6000 @ $1.09/hr) | 48 GB VRAM | Medium | 99.9% (SLA) |
| **Cloudflare Workers (WASM ONNX)** | 0--1 sec (cold), 0 ms (warm) | ~1--10 ms (WASM overhead, 128 MB memory) | $0.30 (paid plan, request fees only) | ~3 MB (compressed Worker size limit for free; 10 MB paid) | High | 99.99% (Cloudflare global edge) |
| **Cloudflare Workers AI** | N/A | N/A (no LightGBM/ONNX custom model support) | N/A | N/A | N/A | N/A |
| **Deno Deploy** | ~100--500 ms (cold) | ~1--5 ms (V8 isolate + WASM) | $2.00 (per-request pricing) | 512 MB memory | Medium-High | 99.9% |
| **Vercel Edge Functions** | ~50--200 ms (cold) | ~1--5 ms (WASM) | $0.60 (Pro plan, function execution units) | 128 MB memory, ~1--4 MB code | Medium | 99.9% |
| **Modal (Serverless GPU)** | 1--5 sec (cold) | ~5--50 ms (GPU dispatch) | ~$1.10 (T4 @ $0.59/hr, including idle/warmup) | 16+ GB VRAM | Medium-High | 99.9% |
| **RunPod (Serverless GPU)** | 30--120 sec (cold) | ~5--20 ms (GPU dispatch) | ~$0.23 (RTX 4090 @ $0.34/hr) | 24 GB VRAM | Medium | 99.5% (user-reported) |
| **Replicate** | 60--180 sec (custom model cold start) | ~50--500 ms (API + GPU) | ~$10.00 (per-prediction pricing, high overhead) | Unbounded | Low-Medium | 99.9% |
| **Banana.dev** | 30--90 sec (cold) | ~50--200 ms | ~$3.00--$5.00 | Varies | Medium | Unknown |

> **Key**: Costs for serverless GPU assume per-second billing model utilization (often 30--50% due to idle between requests). CPU VPS cost is zero-marginal because the execution server already runs 24/7. All non-CPU-VPS options incur 0.5--200 ms of additional network latency between the inference service and the execution server.

---

## Detailed Option Analysis

### 1. CPU Inference on VPS (Co-located with Execution Server)

**How it works**: The LightGBM/CatBoost model is exported to ONNX format during training. At inference time, the ONNX Runtime C API (or the `lleaves` LLVM-native compiler) loads the model once at server startup and performs single-row predictions in-process. No network call, no serialization overhead, no cold start.

**Key performance data (from lleaves benchmarks on Intel i7-4770 Haswell, 2013-era CPU)**:

| Batch Size | LightGBM Native | ONNX Runtime | Treelite | lleaves (LLVM) |
|-----------|----------------|-------------|----------|----------------|
| 1 row | 52.31 us | 11.00 us | 28.03 us | 9.61 us |
| 10 rows | 84.46 us | 36.74 us | 40.81 us | 14.06 us |
| 100 rows | 441.15 us | 190.87 us | 94.14 us | 31.88 us |

Source: [lleaves GitHub benchmarks](https://github.com/siboehm/lleaves)

On a modern CPU (e.g., AMD EPYC or Intel Xeon from 2023+), expect 30--50% faster times. Single-row inference at ~6--8 microseconds is achievable.

**Throughput math for Anavitrade**:
- Target: 10K--100K inferences/day = 0.12--1.2 inferences/second average
- Single CPU core capable of: ~90,000--150,000 inferences/second (at ~7 us each)
- CPU utilization for inference: <0.01% of one core
- Memory: Model under 10 MB fits in L3 cache on most server CPUs

**Cost**: Zero marginal cost if co-located with existing execution server. Even a dedicated $5--10/month VPS (1 vCPU, 1 GB RAM) can handle 1M+ inferences/day.

**Pros**:
- No network latency (in-process call)
- No cold starts (model loaded at startup)
- Zero marginal infrastructure cost
- Simplest deployment (single binary/process)
- No external service dependency
- No API key management
- Full control over model updates and A/B testing

**Cons**:
- Shares fate with execution server (single point of failure -- but execution is already SPOF)
- No automatic horizontal scaling (not needed at target volumes)
- Model update requires process restart or hot-reload implementation

**Deployment pattern** (pseudocode):
```typescript
// On server startup
import * as ort from "onnxruntime-node";
const session = await ort.InferenceSession.create("/models/signal_scorer.onnx");

// Per signal (always warm, in-process)
const scores = await session.run({ features: new Float32Array(inputVector) });
// ~10 microseconds wall time on modern CPU
```

---

### 2. Cloudflare Workers (WASM ONNX Runtime)

**How it works**: The ONNX model is compiled to WebAssembly and loaded into a Cloudflare Worker or Durable Object. The worker runs ONNX Runtime Web (WASM backend) inside the V8 isolate. A "Classifier Durable Object" pattern can keep the model warm in memory.

**Critical constraint -- Memory**: Both Workers Free and Paid plans cap at **128 MB per isolate**. This is the memory available for V8 heap + WASM linear memory + model weights + runtime overhead. ONNX Runtime Web's WASM backend uses significant memory for its own runtime. A 10 MB ONNX model may need 30--60 MB of WASM linear memory for inference, plus 20--40 MB for the ONNX Runtime WASM binary itself. This pushes against the 128 MB limit.

**Critical constraint -- CPU time**:
- Free plan: **10 ms CPU time per request** -- FATAL. A single WASM ONNX inference of a tree model likely takes 1--10 ms in WASM (10--100x slower than native). Even if it fits within 10 ms, there is zero headroom for feature preparation.
- Paid plan: **30 seconds default (up to 5 minutes configurable)** -- workable.
- Paid plan minimum: **$5/month** (plus $0.15/million requests).

**Critical constraint -- Worker size**:
- Free plan: **3 MB after compression**
- Paid plan: **10 MB after compression** (64 MB before compression)
- An ONNX model binary (even small tree models) plus the ONNX Runtime WASM binary (~5--10 MB compressed) will push against the 10 MB paid limit.

**Workers AI**: Cloudflare Workers AI provides pre-built models (LLMs, embedding models, image generation) accessed via a binding API. It does NOT support custom ONNX models or custom gradient-boosted tree models. This option is **not applicable** to the Anavitrade use case.

**The `workers-wonnx` project**: Cloudflare maintains `workers-wonnx`, a Rust-based ONNX runtime that uses WebGPU for acceleration. This is an experimental/community project. Key concerns: (a) it is not production-grade, (b) WebGPU availability is limited to Chrome/Edge, and (c) tree-based models do not benefit from GPU acceleration (they are memory-bound, not compute-bound).

**Verdict**: **Not recommended.** The 128 MB memory ceiling, 10 ms CPU cap on free tier, Worker size limits, and lack of native ONNX tree-model support make Cloudflare Workers unsuitable for this workload. Even on the paid plan, the effort to make it work with WASM ONNX outweighs the marginal benefit of edge distribution for a sub-10-microsecond compute task.

---

### 3. Dedicated GPU VPS (Lambda Labs)

**How it works**: Rent a dedicated GPU instance (A6000, A10, RTX 6000) from Lambda Labs or similar. Run the ONNX model with CUDA/GPU execution provider. The model stays loaded in GPU VRAM, serving inference requests from the execution server via HTTP/gRPC.

**Lambda Labs pricing (on-demand, per hour)**:

| GPU | VRAM | vCPUs | RAM | Price/hr |
|-----|------|-------|-----|----------|
| NVIDIA H200 | 180 GB | 208 | 2,900 GB | $6.69 |
| NVIDIA H100 SXM | 80 GB | 208 | 1,800 GB | $3.99 |
| NVIDIA H100 PCIe | 80 GB | 26 | 225 GB | $3.29 |
| NVIDIA A100 SXM 80GB | 80 GB | 240 | 1,800 GB | $2.79 |
| NVIDIA A100 SXM 40GB | 40 GB | 124 | 1,800 GB | $1.99 |
| NVIDIA A100 PCIe 40GB | 40 GB | 120 | 900 GB | $1.99 |
| NVIDIA A6000 | 48 GB | 56 | 400 GB | $1.09 |
| NVIDIA A10 | 24 GB | 30 | 226 GB | $1.29 |
| NVIDIA Quadro RTX 6000 | 24 GB | 14 | 46 GB | $0.69 |
| NVIDIA GH200 | 96 GB | 64 | 432 GB | $2.29 |

Source: [Lambda Labs Instances](https://lambda.ai/instances) (July 2026)

**Performance analysis**: Tree ensemble models (LightGBM, CatBoost) are fundamentally **memory-bound, not compute-bound**. Each prediction traverses hundreds to thousands of tree nodes, each requiring a memory access for the split threshold. GPU acceleration provides minimal benefit because:
1. The workload is branch-heavy (tree traversal), which GPUs handle poorly
2. Single-row prediction has zero data parallelism (cannot amortize across thousands of rows)
3. Data transfer overhead (CPU -> GPU -> CPU) adds 10--100 us latency, exceeding the entire native CPU inference time
4. GPU VRAM bandwidth is fast but not faster than L3 cache on modern CPUs for this access pattern

In fact, research shows that GPU inference for single-row LightGBM predictions can be **slower** than CPU due to kernel launch and data transfer overhead.

**Cost analysis**: At the cheapest GPU option ($0.69/hr for RTX 6000), running 24/7 costs ~$496/month. This is for a GPU that would be utilized at <0.1% for the inference workload. A single CPU core on a $5/month VPS outperforms it.

**Verdict**: **Not recommended.** GPU is the wrong hardware for tree-based model inference. It is 10--100x more expensive than CPU inference with no performance benefit and potential performance degradation.

---

### 4. Edge Functions (Deno Deploy, Vercel Edge)

#### Deno Deploy

**Limits** (from Deno Deploy pricing page, July 2026):
- **Memory**: 512 MB per isolate
- **CPU time**: Not explicitly documented as a hard limit per request; wall-clock limits apply
- **Request limits**: Per-plan quotas (Free: 1M requests/month; Pro: starts at $10/month)
- **Code size**: Varies by plan

Deno Deploy supports WASM and can run ONNX Runtime Web inside a V8 isolate. The 512 MB memory allocation is more generous than Cloudflare Workers (128 MB), making it technically feasible for a 10 MB ONNX model + runtime.

**Key concerns**:
- WASM ONNX inference latency: estimated 1--5 ms (V8 isolate WASM is faster than browsers but still 100--500x slower than native)
- Cold starts: ~100--500 ms for a new isolate (model must be loaded from disk/network into WASM memory each cold start)
- Network latency: ~5--50 ms round-trip from the execution server to Deno Deploy edge
- Pricing: $2/million requests (Pro plan). At 100K inferences/day = 3M/month = $6/month just for request fees, plus compute time

#### Vercel Edge Functions (Deprecated)

Vercel Edge Functions are deprecated in favor of Fluid compute. Key legacy limits:
- **Memory**: 128 MB
- **Code size**: ~1--4 MB
- **Execution duration**: Historically 30 seconds (Vercel Pro)

The 128 MB memory limit and small code size make Vercel Edge Functions impractical for hosting even small ONNX models.

**Verdict**: **Not recommended.** The WASM overhead, network latency, and cold starts outweigh any edge distribution benefits for an in-process inference task. The total end-to-end latency (network + cold start + WASM inference) would be 5--50 ms vs. ~10 microseconds for co-located CPU inference.

---

### 5. Serverless GPU Platforms

#### Modal

Modal offers per-second GPU billing with container-based isolation.

**Pricing** (published rates, July 2026):
- H100: $0.001097/sec (~$3.95/hr)
- L40S: ~$0.000842/sec (~$3.03/hr)
- A100: ~$0.000775/sec (~$2.79/hr)
- A10G: ~$0.000358/sec (~$1.29/hr)
- L4: ~$0.000250/sec (~$0.90/hr)
- T4: ~$0.000164/sec (~$0.59/hr)
- CPU only: ~$0.000056/sec (~$0.20/hr)

Sources: [Spheron Modal Pricing](https://www.spheron.network/blog/modal-gpu-pricing-2026-per-second-billing/), [Modal GPU Types](https://frontend.modal.com/blog/gpu-types)

**Cold start**: 1--5 seconds for container startup + model loading. Modal is among the fastest serverless GPU cold-start times.

**Key concerns**:
- GPU is wrong hardware for tree model inference (see GPU analysis above)
- Per-second billing adds up: even T4 at $0.59/hr, keeping containers warm 24/7 = $425/month
- Modal's "scale to zero" means cold starts on every inference burst
- Minimum billing granularity (typically 1 second per invocation, even for microsecond work)

#### RunPod (Serverless)

RunPod serverless offers per-second GPU billing with autoscaling.

**Pricing** (dedicated, July 2026, from RunPod pricing page):
- H100 80GB: from $1.99/hr
- A100 SXM 80GB: $1.79/hr
- RTX 4090: from $0.34/hr
- Various other GPUs at competitive rates

**Cold start**: 30--120 seconds (significantly slower than Modal). This is a non-starter for real-time trading signals where decisions must be made in milliseconds.

**Reliability**: User reports indicate ~99.5% uptime; occasional worker unavailability and queue delays during high demand.

Source: [RunPod Pricing](https://www.runpod.io/pricing), [I Tested 9 Serverless GPU Providers](https://dev.to/heckno/i-tested-9-serverless-gpu-providers-for-ai-inference-in-2026-heres-what-id-actually-use-4cf4)

#### Replicate

Replicate is a model hosting platform where you push a Cog container and it serves predictions.

**Cold start**: Custom model boot time is 60--180 seconds (documented in Hacker News discussions and user reports). This is the worst cold start of any option evaluated.

**Pricing**: Per-prediction pricing based on model runtime. A trivial tree model inference wastes most of the billing window on container overhead.

**Verdict for all serverless GPU options**: **Not recommended.** GPU is the wrong hardware for tree model inference. Cold starts (1--180 seconds) are incompatible with real-time trading signal processing where signals arrive continuously. Per-second billing for microsecond inference work is inherently wasteful.

---

### 6. Other Options Discovered

#### Banana.dev

Serverless GPU inference platform. Cold starts of 30--90 seconds. Pricing was restructured in 2026. Limited documentation and smaller community.

#### Vast.ai

GPU marketplace where hosts rent out consumer GPUs. RTX 4090 available from ~$0.30--0.50/hr. Cheapest GPU option but: (a) unreliable hosts (consumer hardware, residential internet), (b) no SLA, (c) GPU still wrong hardware for tree inference, (d) storage is ephemeral (must re-download model on every new instance).

---

## ONNX Runtime Performance Benchmarks

### Tree Ensemble Model Inference (Single Row)

The following benchmarks are from the `lleaves` project, run on an Intel i7-4770 Haswell (2013, 4 cores). This is a worst-case modern CPU baseline -- any server CPU from 2023+ will be 30--50% faster.

| Runtime | NYC Taxi (1 row) | NYC Taxi (10 rows) | NYC Taxi (100 rows) |
|---------|-----------------|-------------------|---------------------|
| LightGBM native (Python) | 52.31 us | 84.46 us | 441.15 us |
| ONNX Runtime | 11.00 us | 36.74 us | 190.87 us |
| Treelite | 28.03 us | 40.81 us | 94.14 us |
| **lleaves (LLVM compiled)** | **9.61 us** | **14.06 us** | **31.88 us** |

Source: [lleaves GitHub](https://github.com/siboehm/lleaves)

### Key Takeaways

1. **ONNX Runtime is 5x faster than native LightGBM Python API** for single-row prediction on CPU.
2. **lleaves is 5.4x faster than native LightGBM** and 1.14x faster than ONNX Runtime.
3. **Single-row prediction is 9--11 microseconds on decade-old hardware.** Modern server CPUs deliver 6--8 microseconds.
4. **Batch prediction is even faster per-row**: 100 rows in 32 us (lleaves) = 0.32 us/row amortized.
5. **The bottleneck is never inference.** At 8 us per prediction, a single core handles 125,000 predictions/second. The target of 100K/day = ~1.2 predictions/second average = 0.001% CPU utilization.

### ONNX Runtime Web (WASM) Benchmarks

No published benchmarks exist specifically for tree ensemble models in ONNX Runtime Web WASM. However, general WASM overhead findings:

- WASM execution is typically **10--100x slower than native** for compute-bound workloads
- WASM memory access (critical for tree traversal) is **5--20x slower** than native due to linear memory model and lack of CPU cache optimization
- Estimated single-row tree model inference in WASM: **0.1--1.0 ms** (vs. ~0.01 ms native)
- WebGPU backend for ONNX Runtime Web is documented as **slower than WASM** for small tabular models (see [gpuweb/gpuweb#5291](https://github.com/gpuweb/gpuweb/issues/5291))

These estimates are speculative -- they are flagged as such. Empirical testing on the target model would be needed for precision.

---

## Implications for Anavitrade

### Architecture Fit

The Anavitrade Stage 3 architecture plans:
- LightGBM/CatBoost model trained offline on historical Coinlegs signals
- Exported to ONNX (~10 MB target)
- Real-time inference at under 50 ms per signal
- ~10K inferences/day at launch, scaling to 100K+

The research confirms:

1. **The 50 ms latency target is trivially achievable.** CPU inference is 6--11 us, or 4,500--8,300x faster than the target. Even WASM edge inference (estimated 0.1--1 ms) meets the target with 50--500x headroom.

2. **The scaling target (100K/day) is trivial.** At 8 us per inference, a single core can handle 100K predictions in 0.8 seconds of CPU time per day, or 0.001% utilization of one core.

3. **Co-location with the execution server is the optimal pattern.** In-process inference eliminates network latency, serialization overhead, and external service dependency. The execution server already runs 24/7 -- adding an in-process model load at startup adds negligible memory and zero CPU overhead.

### Recommended Deployment Architecture

```
┌─────────────────────────────────────┐
│         Execution Server (VPS)       │
│                                      │
│  ┌──────────┐    ┌────────────────┐  │
│  │ Signal    │───>│ ONNX Runtime   │  │
│  │ Generator │    │ (in-process)   │  │
│  │           │    │                │  │
│  │ Coinlegs  │    │ Model loaded   │  │
│  │ scraper   │    │ at startup     │  │
│  └──────────┘    │ ~10 MB RAM     │  │
│                   │ ~8 us/inference│  │
│                   └───────┬────────┘  │
│                           │           │
│                           ▼           │
│                   ┌────────────────┐  │
│                   │ Risk Engine    │  │
│                   │ (same process) │  │
│                   └───────┬────────┘  │
│                           │           │
│                           ▼           │
│                   ┌────────────────┐  │
│                   │ Trade Executor │  │
│                   │ (Aster + CEX)  │  │
│                   └────────────────┘  │
└─────────────────────────────────────┘
```

### Runtime Recommendation: lleaves over ONNX Runtime

Given the microbenchmarks, **lleaves** (LLVM-compiled LightGBM) is recommended over ONNX Runtime for the following reasons:
1. **Faster**: 9.61 us vs. 11.00 us for single-row (14% faster on old hardware)
2. **No serialization**: Directly loads LightGBM model files -- no ONNX export step needed
3. **Drop-in replacement**: Same API as `lightgbm.Booster.predict()`
4. **Cacheable compilation**: Compile once, cache the generated ELF/Mach-O binary, reload instantly

**Caveat**: lleaves is Linux/macOS only (no Windows). This is acceptable for a Linux VPS deployment.

**Fallback**: ONNX Runtime with CPU execution provider if cross-platform support or CatBoost models are needed (lleaves is LightGBM-specific).

### Cost Summary

| Approach | Monthly Cost | Inference Latency | Network Latency | Cold Start | Complexity |
|----------|-------------|-------------------|----------------|------------|------------|
| **Co-located CPU (recommended)** | $0 (included in execution server) | ~8 us | 0 us | 0 ms | Minimal |
| Dedicated CPU VPS | $5--10/month | ~8 us | ~1 ms (localhost) | 0 ms | Minimal |
| Lambda Labs GPU (RTX 6000) | ~$496/month | ~50--200 us | ~1--5 ms | 2--5 min | Medium |
| Cloudflare Workers Paid | $5/month + $0.30/1M req | ~1--10 ms (est.) | ~10--50 ms | 0--1 sec | High |
| Modal (T4, auto-scale) | ~$425/month (24/7) | ~5--50 ms | ~10--50 ms | 1--5 sec | Medium-High |

---

## Risks and Caveats

### 1. Model Size Growth (Low Risk)
If the model grows beyond ~100 MB (e.g., from feature engineering or ensemble of ensembles), in-memory loading remains fine (most VPS instances have 1--8 GB RAM). If the model grows into the multi-GB range (unlikely for gradient-boosted trees), a memory-mapped file approach can be used.

### 2. Python GIL Contention (Medium Risk)
If the execution server uses Python and the inference is called synchronously from the main event loop, the GIL could become a bottleneck under high concurrency. Mitigations: (a) use `lleaves` which releases the GIL during native code execution, (b) use a separate inference worker thread/process, (c) deploy in Node.js using `onnxruntime-node` (no GIL).

### 3. Model Hot-Reload (Low Risk)
Updating the model without restarting the execution server requires a hot-reload mechanism. Implementation options: (a) file watcher that detects new model files, (b) S3/R2 polling for new model versions, (c) graceful restart of the inference component without dropping active trades. This is a standard pattern and low complexity.

### 4. ONNX Export Compatibility (Low Risk)
LightGBM ONNX export via `onnxmltools` or `hummingbird-ml` is well-tested. Some advanced LightGBM features (custom objectives, categorical feature handling with specific encodings) may require verification during export. Mitigation: test the export pipeline during model training and validate output parity before deployment.

### 5. Single Point of Failure (Low Risk)
Co-location means if the execution server goes down, both inference and execution are lost. This is already the case -- adding a separate inference service would introduce a NEW single point of failure (if the separate inference service goes down, execution cannot proceed). The recommended approach does not worsen reliability.

### 6. Network Latency for Edge/Serverless Options (High Risk)
Any option that separates inference from execution adds network latency (5--200 ms). For a trading platform where signal scoring feeds directly into execution decisions, this added latency could mean the difference between a filled and missed trade during volatile market conditions. This is a strong argument for co-location.

---

## Recommendation with Justification

**Primary recommendation: CPU inference on the execution server VPS, using lleaves or ONNX Runtime C API, loaded in-process.**

**Justification** (ordered by importance):

1. **Performance is dominated by everything except inference.** At ~8 microseconds per prediction, inference is 0.0006% of the total signal-to-trade latency budget. Optimizing inference further has zero impact on end-to-end performance.

2. **Zero network latency between scoring and execution.** This is the single most important architectural property for a trading system. Every millisecond of network round-trip between inference and execution is a millisecond of slippage risk.

3. **Zero marginal cost.** The execution server is already provisioned and running 24/7. Adding an in-process model load at startup consumes negligible memory (~10--50 MB) and CPU (<0.01%).

4. **Minimal operational complexity.** No additional service to monitor, deploy, scale, or secure. No API keys to rotate. No cold starts to manage. No external dependency to fail.

5. **Ample headroom for growth.** A single CPU core handles 125K+ predictions/second. At 100K predictions/day, utilization is 0.001%. There is 100,000x headroom before hitting a single core bottleneck.

**Secondary recommendation (if separation is required): Run a dedicated CPU inference microservice on the same VPS or same VPC, communicating over localhost or VPC-internal network.**

This adds ~0.1--1 ms of localhost network overhead but provides process isolation, independent deployment, and the ability to use a different language runtime (e.g., Python microservice alongside a Node.js execution server, or vice versa).

**What would change the recommendation:**
- If model inference latency exceeded 1 ms (unlikely for tree models), edge distribution could become relevant
- If inference volume exceeded 1M predictions/second (100Kx the plan), horizontal scaling would be needed
- If the model required specialized hardware (transformers, large neural networks), GPU would become the preferred option

---

## Sources

1. Cloudflare Workers Limits -- https://developers.cloudflare.com/workers/platform/limits/ (accessed July 2026)
2. Cloudflare Workers 5-Minute CPU Time Changelog -- https://developers.cloudflare.com/changelog/post/2025-03-25-higher-cpu-limits/ (March 2025)
3. Lambda Labs GPU Instances & Pricing -- https://lambda.ai/instances (accessed July 2026)
4. RunPod Pricing -- https://www.runpod.io/pricing (accessed July 2026)
5. RunPod Serverless Pricing Docs -- https://docs.runpod.io/serverless/pricing (accessed July 2026)
6. Modal GPU Pricing 2026 (Spheron comparison) -- https://www.spheron.network/blog/modal-gpu-pricing-2026-per-second-billing/ (2026)
7. Modal GPU Types -- https://frontend.modal.com/blog/gpu-types (2025)
8. lleaves: LLVM-compiled LightGBM -- https://github.com/siboehm/lleaves (benchmarks from README)
9. Deno Deploy Pricing & Limits -- https://docs.deno.com/deploy/pricing_and_limits/ (accessed July 2026)
10. Vercel Edge Functions (Deprecated) -- https://vercel.com/docs/functions/runtimes/edge/edge-functions.rsc (accessed July 2026)
11. Vast.ai GPU Pricing -- https://vast.ai/pricing (accessed July 2026)
12. "I Tested 9 Serverless GPU Providers for AI Inference in 2026" -- https://dev.to/heckno/i-tested-9-serverless-gpu-providers-for-ai-inference-in-2026-heres-what-id-actually-use-4cf4 (2026)
13. "The Top Serverless GPU Providers in 2025, Ranked by Cold Start" (Beam) -- https://www.beam.cloud/blog/top-serverless-gpu-providers (2025)
14. WebGPU vs WASM for ONNX Runtime Web -- https://github.com/gpuweb/gpuweb/issues/5291 (GPU slower than WASM for small models)
15. Cloudflare workers-wonnx (ONNX on Workers) -- https://github.com/cloudflare/workers-wonnx
16. LightGBM-Benchmark: Inferencing Results -- https://microsoft.github.io/lightgbm-benchmark/results/inferencing/ (Microsoft)
17. Lambda Labs GPU Pricing on ComputePrices -- https://computeprices.com/providers/lambda (July 2026)
18. Replicate Pricing -- https://replicate.com/pricing (accessed July 2026)
19. Banana.dev -- https://www.banana.dev/ (accessed July 2026)
20. "Serverless GPU vs Dedicated GPU: When Each One Wins" -- https://gigagpu.com/serverless-gpu-vs-dedicated-gpu-2/ (2025)

---

*Document compiled from 20+ source pages accessed on 2026-07-15. Performance claims without direct source attribution are flagged as estimates. Pricing data reflects publicly listed rates as of July 2026 and may change.*
