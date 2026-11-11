# System Prompt and Guide: SwarmAgents Project Model Integration

This document serves as the institutional prompt and integration guide for the AI Agent working inside the swarmagents project. Use this to configure LLM provider settings, set routing modes, and coordinate the deployment, sharing, and download of the project's models.

## 1. Directory Locations & Model Inventory

All quantized models are currently stored on the local filesystem under the directory: 👉 `/Users/yaeger/AI/models`

### Available SwarmAgents Models & Configurations

| Swarm Model Name | Original Model File | File Size (GB) | Parameter Size (Active / Total) | Inference Token Speed | ELO (Baseline) | ELO (Option A Wrapper) | ELO (Option B Wrapper) | System Purpose & Use Cases |
|-----------------|---------------------|----------------|----------------------------------|-----------------------|----------------|------------------------|------------------------|--------------------------|
| SWARMAGENT-26B-A4B | SWARMAGENT-26B-A4B.gguf | 11.9 GB | ~4B active / 26B total (MoE) | ~25 - 35 tokens/sec | 1389 | 1458 | 1456 | High-capacity multi-agent orchestration, complex mathematical proofs, semantic validation, and deep reasoning loops. |
| swarmagent-core:16.9b-q8 | swarmagent-core-16.9b.gguf | 14.6 GB | 16.9B / 16.9B (Dense) | ~30 - 40 tokens/sec | 1402 | 1330 | 1331 | High-precision programming logic, CAS-based concurrency algorithms, and system architecture design. |
| swarmagent-core:16.9b-q4 | swarmagent-core-16.9b-q4.gguf | 8.4 GB | 16.9B / 16.9B (Dense) | ~45 - 55 tokens/sec | 1373 | 1363 | 1363 | Fast programming tasks, API integrations, and code syntax generation with balanced latency. |
| swarmagent-hyper:7b-a1b | swarmagent-hyper-7b-a1b.gguf | 4.9 GB | 1B active / 7B total (MoE) | ~70 - 90 tokens/sec | 1050 | 1160 | 1170 | Balanced sub-agent execution, logic routing, and medium-complexity task pipelines. |
| swarmagent-hyper:1b | swarmagent-hyper-1b.gguf | 1.1 GB | 1B / 1B (Dense) | ~90 - 120 tokens/sec | 1000 | 1122 | 1130 | High-frequency intent routing, lightweight sub-agent tasks, state tracking, and rapid token generation. |

## 2. Dynamic Routing Wrappers (Option A & Option B)

The custom server engine `/Users/yaeger/AI/core/yaeger_server.py` supports two primary wrapper modalities that work with any model in the inventory:

### Option A: High-Frequency Active-State Router

**How it works:** Monitors prompts and dynamically loads/toggles active expert paths on the fly.

**Active Parameters during Inference:** Toggles active expert weights dynamically, maintaining low active parameters for fast response.

**Best Used For:** Task delegation, quick intent parsing, routing simple tools, and high-speed execution.

**Activation:** Set environment variable `YAEGER_ROUTING_MODE=OPTION_A` when launching yaeger_server.py.

### Option B: Expert MoE Router (Standard & Max Cognitive)

**How it works:** Spawns and maps specialized expert heads (covering fields like concurrency, math, logic, system design, etc.) for high thread contention out of a total registry of 256 experts.

**Standard Option B (8 Active Experts):** Activates 8 distinct expert heads in a structured Mixture of Experts configuration.

**Activation:** Set environment variable `YAEGER_ROUTING_MODE=OPTION_B` when launching yaeger_server.py.

**Max Cognitive Option B (32 Active Experts):** Activates 32 distinct expert heads simultaneously, blending their generation probabilities for maximal reasoning performance.

**Activation:** Set environment variables `YAEGER_ROUTING_MODE=OPTION_B_MAX` or `YAEGER_ROUTING_MODE=OPTION_B` with `YAEGER_ACTIVE_EXPERTS=32` when launching yaeger_server.py.

## 3. How to Upload and Share (Hugging Face Uploads)

To publish these models for the community or your team to access:

### Uploading to Hugging Face

**Authenticate Hugging Face CLI:**
```bash
huggingface-cli login
```

**Execute the distribution script:**
- Script Location: `/Users/yaeger/AI/scripts/upload_to_hf.sh`
- Run Command:
```bash
bash /Users/yaeger/AI/scripts/upload_to_hf.sh
```

(This script automatically packages the local models and uploads them to the target model repository at huggingface.co/swarmagents/swarmagent-models).

## 4. How Users Can Download and Run Models

Any user can download our recommended model files easily. We publish and maintain public versions of all our customized, fused models on Hugging Face and Ollama.

### Option 1: Direct Download (GGUF Files)

Users can download any recommended SwarmAgents GGUF model directly from the Hugging Face model repository:

```bash
# SWARMAGENT-26B-A4B (Gemma-4 MoE, ~4B active)
wget https://huggingface.co/swarmagents/swarmagent-models/resolve/main/SWARMAGENT-26B-A4B.gguf -O SWARMAGENT-26B-A4B.gguf

# SwarmAgent Core 16.9B Q8 Precision
wget https://huggingface.co/swarmagents/swarmagent-models/resolve/main/swarmagent-core-16.9b.gguf -O swarmagent-core_q8.gguf

# SwarmAgent Core 16.9B Q4 Balanced
wget https://huggingface.co/swarmagents/swarmagent-models/resolve/main/swarmagent-core-16.9b-q4.gguf -O swarmagent-core_q4.gguf

# SwarmAgent Hyper MoE 7B (1B active)
wget https://huggingface.co/swarmagents/swarmagent-models/resolve/main/swarmagent-hyper-7b-a1b.gguf -O swarmagent-hyper-7b-a1b.gguf

# SwarmAgent Hyper 1B
wget https://huggingface.co/swarmagents/swarmagent-models/resolve/main/swarmagent-hyper-1b.gguf -O swarmagent-hyper_1b.gguf
```

### Option 2: Running via Ollama

To pull and run any recommended model through the Ollama registry:

```bash
ollama pull swarmagents/swarmagent-models:26b-a4b        # Pulls SWARMAGENT-26B-A4B
ollama pull swarmagents/swarmagent-models:16.9b-q8       # Pulls SwarmAgent Core 16.9B Q8
ollama pull swarmagents/swarmagent-models:16.9b-q4       # Pulls SwarmAgent Core 16.9B Q4
ollama pull swarmagents/swarmagent-models:7b-a1b         # Pulls SwarmAgent Hyper 7B MoE
ollama pull swarmagents/swarmagent-models:1b             # Pulls SwarmAgent Hyper 1B
```

### How to upload/push models to the Ollama Registry

Yes, you can upload these baked models directly to the Ollama registry. The agent or user can push them using the following steps:

**Create a Modelfile for the model:**
```dockerfile
FROM ./SWARMAGENT-26B-A4B.gguf
# Add default templates or system parameters if needed
PARAMETER temperature 0.2
```

**Create the model tag locally:**
```bash
ollama create swarmagents/swarmagent-models:26b-a4b -f Modelfile
```

**Push to the registry:**
```bash
ollama push swarmagents/swarmagent-models:26b-a4b
```

### Registered Ollama Device Keys

To authenticate push access to the swarmagents namespace, the following public keys are registered to the Ollama account for device verification (e.g. from your Mac or Sandbox VM):

- **Mac Workstation Key:** `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPVdjN1HFoVmAHTO5eb61kfSUxazHkRaxnZrxYKleKdo yaegers-mac.local`
- **Sandbox/Secondary Key:** `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID8Ax/rxOrPrXzwoEuaagxB/8Hh68F2BwZ+ctFhjVOAT`

## 5. Swarm Integration Checklist for the AI Agent

When assigning tasks to sub-agents inside swarmagents:

### Fused Weights Strategy
The distributed GGUFs uploaded to Hugging Face and Ollama MUST have the fine-tuned LoRA adapters permanently baked/fused into the weights so that offline users get aligned capabilities instantly without wrapper dependencies.

### Runtime Router Strategy
Both Option A and Option B wrappers must remain fully usable at runtime via yaeger_server.py.

- **Option B (8-Expert Router / Standard):** The default option (8 experts in total, top-1 active expert routing). Excellent balance of VRAM, latency, and system orchestration.
- **Option B (32-Expert Router / Max Cognitive):** The ultra-high ELO option (32 experts in total, top-3 active experts run simultaneously during inference, blending their generation probabilities).
  - **VRAM / Disk Overhead:** Since experts are dynamic LoRA adapters (~30MB each), the disk overhead is only ~960MB total. VRAM overhead during active inference is negligible (~100MB), meaning it runs beautifully on workstation scale.
  - **Best Base Model:** Works best with swarmagent-core:16.9b-q8 or SWARMAGENT-26B-A4B due to their architectural capacity for blended logic.
- **Option A (Active-State Router):** Use Option A strictly for specific latency-sensitive routing use cases where its performance peaks (e.g. it scored the highest 1458 ELO on SWARMAGENT-26B-A4B).
- **Baseline Evaluation:** Use routing_mode="NONE" to query baseline performance of standard models directly, bypassing cognitive wrappers.

## 6. Licensing & Commercialization Guidelines

All models in the SwarmAgents ecosystem have been customized, renamed, and packaged for commercial for-profit deployment. While you may distribute them under the swarmagent branding, your product directory must adhere to standard open-source attributions:

### Apache 2.0 Models (Qwen, OLMo, OLMoE)
- **Usage:** Permitted for commercial use, renaming, and rebranding.
- **Condition:** You must include the original Apache 2.0 license notice and attribution in your product directory.

### Llama Community Models (Llama 3.1)
- **Usage:** Permitted for commercial use and rebranding.
- **Condition:** Attributed to Meta Llama. Requires custom licensing from Meta if the product exceeds 700 million monthly active users.

### Gemma Models (Gemma 4 / Gemma 2)
- **Usage:** Permitted for commercial use and rebranding.
- **Condition:** Attributed to Google Gemma, subject to standard acceptable use restrictions.

## 7. Remote VM Sandbox Execution Guide (For AI Agents)

To implement isolated, Devin-style execution safety, any SwarmAgent can run terminal commands and evaluate file states directly inside our secure Azure Standard_FX2mds_v2 VM sandbox.

### How to use the Remote Sandbox VM

Agents should interface with the remote sandbox environment using the helper script: `/Users/yaeger/AI/scripts/remote_sandbox.sh`.

- **Run Commands:** Execute `/Users/yaeger/AI/scripts/remote_sandbox.sh run "<command>"` to evaluate script outputs, compile binaries, or test server endpoints safely inside the VM.
- **Transfer Files:** Copy local scripts up using `/Users/yaeger/AI/scripts/remote_sandbox.sh copy <local_path> <remote_path>`, and pull logs or reports back using pull.

### SwarmAgents Site UI VM Visualizer Directives

- **Real-time VM Visualizer:** On our SwarmAgents web client dashboard, we should build a terminal/workspace window that visually streams the command outputs, file directory states, and CPU/RAM status of the active remote VM in real-time (matching Devin/Manus aesthetics).
- **Access Restriction (Important):** Due to cloud compute capacity constraints, this remote VM execution visualizer must currently be strictly restricted to Admin/Owner accounts only (not allocated to public trial users).
