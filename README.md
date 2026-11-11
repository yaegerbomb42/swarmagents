# SwarmAgents

**A company of agents on your models. Unified control plane & execution harness.**

SwarmAgents brings together the multi-model **SwarmAgents UI & Provider Router** and the **Omnexx Autonomous Execution Substrate** into a single, cohesive repository.

---

## 🏛️ Architecture

```
swarmagents/
├── apps/
│   ├── web/          # SwarmAgents Next.js Frontend & API (https://swarmagents.codes)
│   ├── extension/    # Omnexx VSCode Extension
│   └── cli/          # SwarmAgents & Omnexx CLI Runner
├── packages/
│   ├── engine/       # Omnexx Cognitive Runtime & Harness Engine
│   ├── providers/    # Swarm Provider Manager & Concurrency Racing Layer
│   └── shared/       # Shared types, protocols & schemas
└── deploy/
    ├── Dockerfile    # Standalone Production Container
    └── deploy.sh     # 1-command deploy direct to swarmagents.codes
```

---

## 🚀 Quickstart

### Development
```bash
# Web console
cd apps/web && npm run dev

# CLI runner
cd apps/cli && npm run dev
```

### Deploy to Production (`swarmagents.codes`)
```bash
./deploy/deploy.sh
```

---

## 🔒 Security & Persistence
- Zero external Firebase dependencies required: Built-in instant founder sandbox session.
- BYOK (Bring Your Own Keys) provider vault for Gemini, OpenRouter, Groq, Cerebras, and Anthropic.
