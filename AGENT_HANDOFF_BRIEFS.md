# SwarmAgents — Autonomous Engineering Team Handoff Briefs

This document contains dedicated, production-grade instructions for **Muse**, **Grok Bot**, and your coding assistants (**OpenCode**, **Cline**, **Claude Code**).

- **GitHub Repository**: `https://github.com/yaegerbomb42/swarmagents.git`
- **Local Workspace**: `/Users/yaeger/Desktop/swarmagents`
- **Production URL**: `https://swarmagents.codes` (Deployed on Oracle VPS, zero GitHub Pages)

---

## 🎯 Task 1: Prompt Brief for Muse (UI Simplification: Minimal Input Bar + Live Telemetry)

> **Role**: Principal Product Designer & Frontend Systems Engineer  
> **Repository to Pull**: `https://github.com/yaegerbomb42/swarmagents.git`  
> **Workspace**: `/Users/yaeger/Desktop/swarmagents`

### What Happened & What Needs Rectification:
SwarmAgents accumulated legacy marketing overhead, complex multi-screen dashboard flows, and authentication blockers from old iterations. It has now been decoupled from the monolith and unified with the Omnexx autonomous harness engine. 

### The End Goal for Muse:
Transform the UI into a **way easier, minimal, high-aesthetic command console**:
1. **Primary Interface**: A central, clean tactile input bar (like Linear/Raycast/Claude) for commanding autonomous agents.
2. **Real-Time Telemetry Feed**: A live telemetry HUD displaying execution steps, model tokens/latency, and task status streaming directly from the Omnexx engine.
3. **Provider Quick-Switch**: Simple BYOK model selector (Gemini, OpenRouter, Nemotron, Groq) right below or beside the prompt bar.
4. **Remove Clutter**: Streamline or archive legacy landing clutter so the user lands straight into the operational agent console.

### Prompt to Send to Muse:
```markdown
Pull and work in the SwarmAgents repository:
git clone https://github.com/yaegerbomb42/swarmagents.git
cd swarmagents/apps/web

Context & What Happened:
SwarmAgents previously suffered from cluttered legacy marketing layouts, complicated nested dashboard tabs, and auth roadblocks. We have broken it out into this sovereign repo and merged it with the Omnexx execution harness.

Your Mission:
Redesign and simplify apps/web to deliver an ultra-clean, minimal, high-focus agent workspace:
1. Centered Prompt & Command Bar:
   - Make the hero/home experience instantly actionable with a clean, floating prompt input bar where the user can dispatch missions directly to agents.
2. Live Telemetry & Execution Stream:
   - Below the input bar, render a high-density, real-time telemetry card/feed showing agent thought processes, tool actions, and latency/token counters (fed by /api/harness/task).
3. Provider Selector:
   - Provide a sleek selector pill for switching model backends (Nemotron, Mercury, Gemini, Groq, OpenRouter).
4. Remove Bloat:
   - Bypass confusing sub-pages and ensure anyone arriving at https://swarmagents.codes is immediately in the sleek command interface with zero friction.
5. Verify build:
   - Run `npm run build` inside apps/web to ensure clean compilation.
   - Commit your work with `git commit -am "feat(ui): minimal prompt bar and live telemetry console"` and push to `origin main`.
```

---

## ⚡ Task 2: Prompt Brief for Grok Bot (Nemotron & Mercury Engine Runner / Verification)

> **Role**: Principal Autonomous Systems & Infrastructure Engineer  
> **Repository to Pull**: `https://github.com/yaegerbomb42/swarmagents.git`  
> **Workspace**: `/Users/yaeger/Desktop/swarmagents`  
> **Key Clusters**: Nemotron & Mercury

### What Happened & What Needs Rectification:
SwarmAgents is now powered by **Omnexx as its core runner harness** (`packages/engine`), while `apps/web` provides the UI and API. In the past, the engine and frontend suffered from disjointed schemas, unconfigured Firebase auth walls, and simulated responses. 

### The End Goal for Grok Bot:
1. Wire up the **Nemotron and Mercury API keys** in the engine's key pool and provider manager for high-speed agentic execution.
2. Ensure every task submitted through the minimal input bar in `apps/web` executes through the Omnexx harness runtime (`packages/engine/src/agent/loop.ts` & `swarmagents-bridge.ts`).
3. Deploy the rectified build to production on `https://swarmagents.codes` using `./deploy/deploy.sh`.

### Prompt to Send to Grok Bot:
```markdown
Pull and work in the SwarmAgents repository:
git clone https://github.com/yaegerbomb42/swarmagents.git
cd swarmagents

Context & What Happened:
SwarmAgents has been separated into this clean repository. Omnexx is now the execution engine in packages/engine/, and apps/web is the control plane at https://swarmagents.codes. The previous issues stemmed from Firebase auth errors and disconnected execution backends.

Your Mission:
1. Provider Integration (Nemotron & Mercury):
   - In packages/engine/src/llm/ or apps/web/src/lib/providerTemplates.ts, configure the Nemotron and Mercury provider key clusters.
   - Set up concurrency racing and automatic key rotation so completions run with ultra-low latency and 0 rate limits.
2. Wire Web to Omnexx Engine:
   - Connect apps/web/src/app/api/harness/task/route.ts to the real Omnexx runtime in packages/engine/src/swarmagents-bridge.ts.
   - Ensure dispatched tasks stream live step telemetry back to the client interface.
3. Bug Resolution & Verification:
   - Hunt down and fix any lingering TypeScript errors or runtime gaps between apps/web and packages/engine.
4. Deploy to Production:
   - Run `./deploy/deploy.sh` to build the standalone Docker container and swap it live on the Oracle VPS (147.224.158.118).
   - Test https://swarmagents.codes/api/health and the main console live to verify 100% functionality.
```

---

## 🛠️ Task 3: Prompt Brief for Cline / OpenCode / Claude Code (CLI & VSCode Extension)

> **Role**: Tooling & Developer Experience Engineer  
> **Repository to Pull**: `https://github.com/yaegerbomb42/swarmagents.git`

### Prompt:
```markdown
Pull https://github.com/yaegerbomb42/swarmagents.git and link the developer tooling:
1. apps/cli:
   - Implement `swarm run "<task>"` and `omnexx run "<task>"` to trigger local agent executions via packages/engine.
2. apps/extension:
   - Verify the Omnexx VSCode extension connects directly to https://swarmagents.codes for telemetry and cloud agent runs.
```
