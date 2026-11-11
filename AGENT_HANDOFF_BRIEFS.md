# SwarmAgents — Autonomous Engineering Team Handoff Briefs

This document contains dedicated, modular prompt briefs tailored for **Muse**, **Grok Bot**, and your coding assistants (**OpenCode**, **Cline**, **Claude Code**) to systematically test, debug, and polish the unified `swarmagents` repository.

---

## 🎯 Task 1: Prompt Brief for Muse (Deep Codebase Audit, UI Polish & Linting)

> **Role**: Principal Full-Stack Architect & Code Reviewer  
> **Workspace**: `/Users/yaeger/Desktop/swarmagents`  
> **Repository**: `https://github.com/yaegerbomb42/swarmagents`

### Prompt to Send to Muse:
```markdown
You are acting as the Lead Architect & Code Auditor on the brand-new unified SwarmAgents repository located at:
/Users/yaeger/Desktop/swarmagents

Context:
SwarmAgents has been completely reorganized into a clean sovereign platform:
- apps/web: Next.js 15 full-stack frontend & API deployed to https://swarmagents.codes
- apps/cli: Unified SwarmAgents & Omnexx CLI runner
- apps/extension: VSCode Extension for the harness
- packages/engine: Omnexx Autonomous Cognitive Core & Harness
- packages/providers: Provider keys & concurrency racing layer
- deploy/: Production Docker container and 1-command VPS deploy script

Your Objective:
1. Audit apps/web:
   - Check all page routes (/login, /signup, /decomp, /dashboard, /pricing, /live) for missing imports, syntax inconsistencies, or broken Tailwind styles.
   - Ensure the instant sandbox authentication session in apps/web/src/lib/auth.ts operates flawlessly without throwing unhandled exceptions.
   - Clean up any dead code, unused dependencies in package.json, or duplicate styles.
2. Verify packages/engine (Omnexx):
   - Inspect packages/engine/src/swarmagents-bridge.ts and ensure types line up with the task graph from apps/web/src/types/decomposition.ts.
3. Test builds:
   - Run typechecks and linting where applicable.
   - Deliver a clear summary of all fixes made and commit cleanly to git with descriptive messages.
```

---

## ⚡ Task 2: Prompt Brief for Grok Bot (Nemotron & Mercury Runner / Harness Integration)

> **Role**: Systems & Runtime Verification Engineer  
> **Workspace**: `/Users/yaeger/Desktop/swarmagents`  
> **Execution Substrate**: Omnexx Engine + Fast Provider Key Clusters (Nemotron & Mercury)

### Prompt to Send to Grok Bot:
```markdown
You are acting as the Autonomous Systems & Runtime Engineer on SwarmAgents:
/Users/yaeger/Desktop/swarmagents

Objective:
Verify and harden the live execution loop connecting SwarmAgents (UI/API) with the Omnexx Harness Engine, utilizing your Nemotron and Mercury provider key clusters for blazing fast execution and automated testing.

Key Directives:
1. Harness Bridge Verification:
   - Inspect apps/web/src/app/api/harness/task/route.ts.
   - Connect it with packages/engine/src/swarmagents-bridge.ts to trigger real cognitive loops when tasks are dispatched.
   - Ensure Nemotron and Mercury API providers are registered in packages/engine/src/llm/ or apps/web/src/lib/providerTemplates.ts so tasks can race across NVIDIA/Cerebras/Groq clusters.
2. Live Endpoint Testing:
   - Test https://swarmagents.codes/api/health and https://swarmagents.codes/api/harness/task.
   - Verify that tasks created in the /decomp DAG canvas can post directly to the harness without 404s or 500s.
3. VPS Deployment:
   - If changes are made to apps/web or deploy/, run `./deploy/deploy.sh` to build and verify live container execution on the VPS (147.224.158.118).
4. Provide direct proof of success:
   - Return curl outputs, container logs, and test run results.
```

---

## 🛠️ Task 3: Prompt Brief for Cline / OpenCode / Claude Code (CLI & VSCode Extension Integration)

### Prompt:
```markdown
You are assigned to align the SwarmAgents CLI and VSCode extension in /Users/yaeger/Desktop/swarmagents:
1. apps/cli:
   - Implement `swarm status` and `swarm run "<task>"` using the packages/engine Omnexx runtime.
   - Add alias support for `omnexx` commands.
2. apps/extension:
   - Verify out/extension.cjs loads cleanly in VSCode.
   - Point extension telemetry and API calls to https://swarmagents.codes.
```
