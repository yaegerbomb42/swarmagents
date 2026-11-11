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

---

## 🎨 Task 4: Three Minimalist Agent Dashboard Design Prompts (ChatGPT / Grok / Claude + Live Telemetry & Sandbox VM)

These 3 prompts provide distinct **aesthetic archetypes** (Cyber-Glassmorphism, Minimal Obsidian Neo, and Spatial Horizon). Each is engineered to combine the clean conversational simplicity of **ChatGPT / Claude / Grok** with **high-density telemetry, a live terminal/VM sandbox screen, document authoring, and simulated or real web browsing**.

---

### 🌟 Dashboard Concept 1: "Obsidian Neo-Terminal" (Linear / Grok / Raycast Vibe)
> **Aesthetic Tone**: Ultra-dark pure pitch black (`#050508`), sharp 1px borders with subtle border glow, monospaced status headers, tactile micro-interactions, high-contrast typography.

#### Prompt to Pass to Engineer / Model:
```markdown
Target Repository: https://github.com/yaegerbomb42/swarmagents.git
Target App: apps/web/src/app/ (Route: /dashboard or primary view)

Build an "Obsidian Neo-Terminal" minimalist agent dashboard for SwarmAgents that blends the instant conversational speed of Grok and ChatGPT with live dev environment observability.

Key Requirements:
1. Unified Command Anchor:
   - A central bottom-docked or floating prompt bar featuring an expandable prompt textarea, provider pill selector (Nemotron, Mercury, Gemini, Claude, Groq), and action tags (@browse, @doc, @code).
2. Live Telemetry HUD:
   - A clean top bar showing: Active Model, Tokens/sec, Latency (ms), Sub-agent Status, Working Memory Budget (tokens used / budget), and a "Pause / Intervene" gate button.
3. Split-Pane Workspace (Conversational Flow + Live Execution VM):
   - Left Pane (60%): Clean, uncluttered conversational stream showing agent plan steps, collapsed thinking ribbons (like Claude / ChatGPT), and generated artifacts.
   - Right Pane (40% - Collapsible): "The Autonomous Sandbox":
     * Live Terminal View: Simulated xterm/bash terminal streaming stdout/stderr as the agent installs packages or runs tests.
     * Web Browser Tab: Minimal virtual browser preview showing URLs visited, page titles, and DOM snapshots taken by the agent.
     * Document Canvas Tab: Clean markdown / code editor preview for newly authored documents and reports with 1-click copy/download.
4. Styling:
   - Dark mode: `#030305` background, `#0e0e14` panels with subtle zinc-800 borders, monospace telemetry counters, neon emerald active badges.
```

---

### 💎 Dashboard Concept 2: "Glassmorphic Aurora" (macOS Sequoia / Claude / Linear Vibe)
> **Aesthetic Tone**: Frosted acrylic glassmorphism (`backdrop-blur-2xl`), delicate translucent borders (`border-white/10`), soft ambient background glow (deep violet & cyan gradients), smooth rounded corners (`rounded-3xl`).

#### Prompt to Pass to Engineer / Model:
```markdown
Target Repository: https://github.com/yaegerbomb42/swarmagents.git
Target App: apps/web/src/app/ (Route: /dashboard or primary view)

Build a "Glassmorphic Aurora" minimalist agent dashboard for SwarmAgents that channels the premium elegance of macOS Sequoia and Claude 3.5 with glass panels and fluid animations.

Key Requirements:
1. Floating Frosted Island Layout:
   - Background: Dark cosmic gradient with soft ambient light orbs (`bg-[#070710]` with subtle cyan/violet aurora blurs).
   - The entire UI is built as floating frosted glass cards (`bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] shadow-2xl`).
2. Dual-Engine Command Dock:
   - Elegant pill-shaped floating command island at the bottom center. Includes an inline model toggle, file attachment, web search switch, and multi-line auto-expanding input.
3. Live Agent VM & Telemetry Canvas:
   - Top Telemetry Marquee: Transparent glass strip with glowing dot pulse indicators (Green: Executing, Yellow: Reasoning, Blue: Browsing).
   - Telemetry Stream: Real-time breadcrumb steps ("Localizing files", "Compiling diff", "Executing test matrix").
   - Interactive Artifact Sandbox:
     * Live Interactive Tab: Displays the agent's virtual desktop/browser snapshot.
     * Dynamic Doc Viewer: Glass paper preview for generated documents (PRDs, specs, code diffs).
4. Styling:
   - Frosted blur, glowing highlights on active borders, silky transitions with Framer Motion, Cormorant/Geist font pairing.
```

---

### ⚡ Dashboard Concept 3: "Spatial HUD & Minimal Bento" (Next-Gen AI Workspace)
> **Aesthetic Tone**: Modular Bento Grid, Neo-Brutalist precision meets modern SaaS, collapsible spatial widgets, high utility per square pixel.

#### Prompt to Pass to Engineer / Model:
```markdown
Target Repository: https://github.com/yaegerbomb42/swarmagents.git
Target App: apps/web/src/app/ (Route: /dashboard or primary view)

Build a "Spatial Bento HUD" minimalist agent dashboard for SwarmAgents that merges the modularity of modern dashboard layouts with high-speed autonomous agent feedback.

Key Requirements:
1. Modular 3-Column Bento Grid:
   - Column 1 (Left Nav - 240px / Collapsible): Recent agent threads, active project workspaces, saved documents, and provider settings.
   - Column 2 (Center Workspace - Flexible): The primary chat and reasoning stream. Includes sticky top action bar, message cards with markdown rendering, and inline action buttons ("Apply to Repo", "Run in VM").
   - Column 3 (Right Cockpit - 420px): "Agent Live View":
     * Top Widget: Real-time Telemetry (CPU/RAM consumption, model tokens, task cost estimate).
     * Middle Widget: Embedded VM Terminal / Browser simulator displaying terminal commands executed and URLs fetched during web search.
     * Bottom Widget: Document & Asset Staging area (shows files modified, new markdown docs drafted).
2. Input Experience:
   - Integrated input box at the base of the center workspace with slash commands (`/browse`, `/doc`, `/test`, `/deploy`) and instant provider switching.
3. Styling:
   - Crisp `#08080a` base, `#121217` bento containers, cyan/emerald status highlights, subtle hover scale micro-interactions.
```

---

## 🔬 Task 5: Deep Quality & Hardening Audit (Autonomous Code Health & Anti-Regression)

> **Assigned Agent**: OpenCode / Claude Code / Senior Quality Auditor  
> **Repository to Pull**: `https://github.com/yaegerbomb42/swarmagents.git`  
> **Scope Boundaries**: Strictly read-only analysis of `packages/engine/src/agent/` and `packages/engine/src/autonomous/`, followed by targeted, surgical hardening.

### Prompt to Pass to Auditor Agent:
```markdown
Target Repository: https://github.com/yaegerbomb42/swarmagents.git
Working Directory: packages/engine/

Context:
SwarmAgents has incorporated the entire Omnexx autonomous core into `packages/engine/`. This core contains multi-turn cognitive loops, GOAP planners, self-healing ratchets, AST analyzers, and file-staging primitives. Because this engine is the operational brain for all agent executions, it must possess deterministic stability, zero silent failures, and rock-solid error handling.

Your Objective:
Perform an exhaustive, strongly scoped quality and resilience audit across the autonomous execution core, and harden it against silent stalls or memory bloat.

Strict Scope & Focus Areas:
1. Cognitive Loop & Turn Budgeting (`packages/engine/src/agent/loop.ts` & `turn-budget.ts`):
   - Inspect the termination conditions. Ensure that infinite loops, cascading 429 rate-limit retries, and stuck tool-call cycles are strictly bounded by timeout or turn limit.
   - Verify that abort signals (`AbortController` / `interrupt-bus.ts`) immediately halt downstream worker subprocesses and flush telemetry cleanly.
2. Safe Staging & AST Parsing (`packages/engine/src/autonomous/ast-analysis.ts` & `core/atomicWrite.ts`):
   - Audit atomic writes to ensure corrupt syntax or incomplete code generations never overwrite target project files directly.
   - Ensure the AST parser handles edge-case TypeScript/TSX syntax and returns clean error feedback to the agent instead of throwing unhandled exceptions.
3. Memory & State Leaks (`packages/engine/src/autonomous/state-store.ts` & `agent/rolling-memory.ts`):
   - Check episodic memory compaction. Ensure large session histories are automatically compressed so context token limits are never blown.
4. Output Deliverable:
   - Provide a clear audit report highlighting any identified vulnerabilities or race conditions.
   - Implement surgical fixes with full test coverage where tests exist.
   - Commit cleanly: `git commit -am "fix(engine): harden cognitive loop bounds and AST error handling"`.
```

---

## 🚀 Task 6: Feature Enhancement — Multi-Agent Swarm Collaboration & Live Consensus Replay

> **Assigned Agent**: Grok Bot / Cline / Advanced Multi-Agent Specialist  
> **Repository to Pull**: `https://github.com/yaegerbomb42/swarmagents.git`  
> **Scope Boundaries**: Strictly focused on `packages/engine/src/agent/swarm.ts` and `apps/web/src/components/swarm/` (zero changes to auth or deploy configs).

### Prompt to Pass to Feature Agent:
```markdown
Target Repository: https://github.com/yaegerbomb42/swarmagents.git
Working Directory: packages/engine/src/agent/ & apps/web/src/components/swarm/

Context:
SwarmAgents differentiates itself from single-agent coding tools by orchestrating a coordinated "company of agents" working in parallel—such as a Planner agent, an Author/Coder agent, a Critic/Auditor agent, and a Verifier/Tester agent.

Your Objective:
Enhance and elevate the Swarm collaboration protocol with a high-fidelity "Live Consensus & Delegation Engine" that allows users to see agents debate, vote, and divide tasks in real time.

Strict Scope & Feature Deliverables:
1. Multi-Agent Delegation Bus (`packages/engine/src/agent/swarm.ts` & `orchestration/`):
   - Implement a typed message exchange protocol:
     * `propose_plan`: Planner agent breaks a prompt into sub-tasks.
     * `peer_review`: Critic agent scores the proposal for security, speed, and correctness.
     * `delegate_task`: Coordinator hands sub-tasks to specialized worker seats.
     * `consensus_reached`: Aggregates the collective output before final execution.
2. Live Consensus Replay Feed (`apps/web/src/components/swarm/ConsensusReplay.tsx` or new component):
   - Create a clean visual timeline / chat ribbon where users can inspect agent-to-agent deliberations.
   - Show avatar badges for each agent persona (e.g. 🧠 Architect, ⚡ Rapid Coder, 🛡️ Security Sentinel).
   - Include agreement indicators (e.g., "Consensus: 3/3 Approved" with green glowing badge).
3. Telemetry Event Emitter:
   - Ensure agent consensus events emit standard JSON events so the new minimalist dashboards can subscribe to them via WebSocket or Server-Sent Events (SSE).
4. Validation & Commit:
   - Verify build integrity with `npm run build` in apps/web.
   - Commit your enhancements: `git commit -am "feat(swarm): multi-agent consensus bus and live debate feed"`.
```

---

## ⚡ Task 7: Autonomous Web Research & Intelligent Live Browser Agent (`packages/engine/src/tools/extra/browser/`)

> **Assigned Agent**: Claude Code / Cline / Grok Bot (Specialist in Web Automation & Live Scraping)  
> **Repository to Pull**: `https://github.com/yaegerbomb42/swarmagents.git`  
> **Scope Boundaries**: Strictly confined to `packages/engine/src/tools/extra/browser/` and `apps/web/src/lib/tools/webBrowser.ts`. Zero edits to core UI layout, auth, or deploy files.

### Prompt to Pass to Browser Specialist Agent:
```markdown
Target Repository: https://github.com/yaegerbomb42/swarmagents.git
Working Directory: packages/engine/src/tools/extra/browser/ & apps/web/src/lib/tools/

Context:
The SwarmAgents dashboard requires active web browsing and autonomous research capabilities (@browse and research agents) so agents can search documentation, extract GitHub issues, verify APIs, and inspect web app states in real time. 

Your Objective:
Build and polish a robust, high-performance "Autonomous Web Research & Scraping Pipeline" that streams live browser telemetry (URLs, page titles, cleaned markdown content, and screenshot snapshots) directly to the SwarmAgents console.

Strict Scope & Feature Deliverables:
1. Intelligent Content Extractor (`packages/engine/src/tools/extra/web_extractor.ts` & `web_search.ts`):
   - Implement clean HTML-to-Markdown distillation that strips ads, navbars, and cookie banners to preserve LLM token context.
   - Support DuckDuckGo / SearXNG / Google search fallback queries with multi-engine query fallbacks.
2. Virtual Headless Browser Session Manager (`packages/engine/src/tools/extra/browser/`):
   - Provide safe page navigation (`navigate(url)`), element interaction (`click(selector)`), and text input (`type(selector, text)`).
   - Implement a lightweight visual snapshot generator (returns either a rendered DOM wireframe or Base64 WebP screenshot).
3. Telemetry Stream Event Hook (`apps/web/src/lib/tools/webBrowser.ts`):
   - When an agent browses, emit real-time events:
     * `browser:navigating`: { url, timestamp }
     * `browser:loaded`: { url, title, statusCode, contentLength }
     * `browser:snapshot`: { url, wireframeSnippet, screenshotUrl }
   - These events feed directly into the right-hand browser preview screen on the new minimalist dashboards.
4. Validation & Deliverable:
   - Ensure the browser tool handles timeouts, redirects, and network failures gracefully without throwing unhandled exceptions.
   - Run typechecks and unit tests in `packages/engine`.
   - Commit cleanly: `git commit -am "feat(tools): autonomous web browsing and live telemetry extraction pipeline"`.
```

---

## 🏗️ Task 8: The Dual Backend Engines — Virtual Sandbox VM + Provider Racing Layer

> **Assigned Agent**: OpenCode / Claude Code / Grok Bot  
> **Repository to Pull**: `https://github.com/yaegerbomb42/swarmagents.git`  
> **Scope Boundaries**: Strictly confined to `packages/providers/` and `apps/web/src/lib/sandbox/`.

### Prompt to Pass to Engineer / Model:
```markdown
Target Repository: https://github.com/yaegerbomb42/swarmagents.git
Working Directory: packages/providers/ & apps/web/src/lib/sandbox/

Context:
The SwarmAgents minimalist dashboards require two critical background systems:
1. Provider Key Racing Layer: Multi-key rotation and concurrent completion racing across Gemini, Groq, Cerebras, Nemotron, and Mercury with automatic cooldown for rate-limited (429) keys.
2. Virtual Sandbox VM: A lightweight client-side virtual execution harness that simulates an xterm terminal with stdout/stderr event streaming and virtual filesystem tracking.

Your Objective:
Implement these two isolated engines so the dashboard UI components can immediately plug into them.

Deliverables:

Part 1: Multi-Key Racing Engine (`packages/providers/src/`):
- Implement `KeyPool`: Tracks an array of API keys per provider with exponential backoff on 429/401 errors.
- Implement `ProviderRaceEngine.complete({ prompt, provider, candidates: 3 })`:
  * Concurrently dispatches completion requests across up to N available keys using `Promise.race` or `asyncio.wait(FIRST_COMPLETED)`.
  * Cancels runner-up requests once the fastest valid response arrives.
  * Records moving-average latency and tokens-per-second per key.
- Provide clean TypeScript exports in `packages/providers/src/index.ts`.

Part 2: Virtual Sandbox VM Hook (`apps/web/src/lib/sandbox/`):
- Create `apps/web/src/lib/sandbox/virtualVm.ts`:
  * A lightweight state machine simulating bash execution (`ls`, `cat`, `mkdir`, `npm install`, `node test.js`, `git status`).
  * In-memory virtual filesystem (VFS) to track created and modified files.
  * Event emitter for terminal output lines: `{ type: 'stdout' | 'stderr' | 'exit', text: string, timestamp: number }`.
- Create React hook `useVirtualSandbox()`:
  * Exposes `terminalLogs`, `activeCommand`, `vfsFiles`, `runCommand(cmd)`, and `clear()`.
  * Allows any dashboard component to render a live streaming terminal with zero server execution risk.

Validation & Deliverable:
- Run `npm run build` in `apps/web` to confirm clean typing and compilation.
- Commit cleanly: `git commit -am "feat(providers): multi-key racing engine and virtual sandbox VM hook"`.
- Push to `origin main`.
```
