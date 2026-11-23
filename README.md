# SwarmAgents

**Give it a task. It has its own computer.**

SwarmAgents runs one autonomous agent inside your own persistent Linux VM. Describe the work in one chat bar, watch every step stream live, and take over whenever you want. Free to use — bring your own model keys, or bring your own machine.

**One chat bar. One agent. Every tool. Nothing hidden.**

[![CI](https://github.com/yaegerbomb42/swarmagents/actions/workflows/ci.yml/badge.svg)](https://github.com/yaegerbomb42/swarmagents/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=yaegerbomb42_swarmagents3&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=yaegerbomb42_swarmagents3)

**[Try it live → swarmagents.codes](https://swarmagents.codes)** · [Documentation](docs/README.md) · [Architecture](apps/swarmagents/README.md) · [Contributing](CONTRIBUTING.md)

---

## How it works

1. **Describe the task** — one chat bar, plain language. "Fix the failing tests and open a PR." "Research these three competitors and build me a comparison doc."
2. **Watch it work** — your agent runs inside its own Linux VM: shell, files, browser, desktop. Every command, tool call, and screen streams to you live as it happens.
3. **Steer or take over** — redirect it mid-task, or grab the keyboard and mouse and drive the VM yourself. Autonomy you can watch — and interrupt.
4. **Keep the result** — files, pull requests, reports, and a VM that remembers: the workspace persists between runs, so the next task starts where the last one left off.

## Why SwarmAgents

**Its own computer, not a chat window.** Your agent gets a real, persistent Linux VM — it installs packages, builds projects, runs tests, and drives a desktop. Each user's VM is isolated, resource-capped, and hardened, and the machine is still there tomorrow.

**Nothing hidden. You're always in control.** Every step of a run — text, tool calls, results — streams to your browser in real time, with secrets redacted before they ever reach the wire. Nothing runs behind a curtain.

**Your keys. Your machine. Your rules.** Connect your own provider keys and route each task to the model you choose — keys are stored per user, encrypted, and never pooled or shared. Or run the agent on your own hardware with the BYOC node. The platform is free and open source: no seats, no credits, no token markup.

## Features

- **Persistent per-user VM** — a long-lived Linux container per user with quotas (memory, CPU, process limits, exec duration, output size), an idle sweeper that stops the machine without losing the workspace volume, and a hardened container profile.
- **Live, resumable run streaming** — every agent event is sequenced and streamed over SSE with reconnect/resume, so you can close the tab and pick the run back up.
- **Desktop + computer use** — an optional desktop VM image with VNC and a computer-use MCP server; watch the agent's screen and take over the controls mid-task.
- **Multi-provider BYOK routing** — a provider catalog with per-user encrypted key storage, model routing with hedging and racing, provider health checks, and per-run cost tracking. You pay your provider directly, at their prices.
- **Bring your own computer (BYOC)** — the `swarm-node` package lets your own machine act as the agent's VM instead of a hosted one.
- **Roles and tools** — role cards shape how the agent works, with MCP servers and connectors available per role.
- **Open source, self-hostable** — the whole platform is AGPL-3.0. Run the hosted version, or run your own.

## You're in control

- **Sandboxed by design.** The agent works inside your VM — not on your laptop, not in a shared pool with other users.
- **Visible by default.** The full run transcript streams live; there is no hidden mode.
- **Your keys stay yours.** Provider keys are per-user and encrypted at rest. Signed-in accounts never run on shared host keys.
- **Takeover is one click.** If the agent heads somewhere you don't like, take the controls.

## Pricing

Free. Really. SwarmAgents doesn't sell tokens — you connect your own provider keys (or your own machine) and pay only for what you use, directly to your provider. No seats, no credits, no markup.

## Quick start (local development)

Requirements: Node.js 22 and npm. Docker is optional — outside production the app defaults to a fake VM driver, so you can develop without containers.

```bash
cd apps/swarmagents
npm ci
npm run dev        # http://127.0.0.1:3777
```

Quality gates (the same checks CI runs):

```bash
npm run typecheck
npm run test:unit
npm run lint
npm run build
```

To build the real VM images: `npm run vm-image:build` (headless) and `npm run vm-image-desktop:build` (desktop).

## Architecture

```
Browser (Next.js app router, React 19)
  |  POST /api/runtime/tasks, GET /api/runtime/stream/[runId] (SSE)
  v
lib/runtime/manager.ts   per-user run control plane (one active run + FIFO queue)
  v
lib/vm/manager.ts        per-user persistent VM (Docker or fake driver, quotas)
  v
lib/harness/runner.ts    drives the agent CLI, normalizes its event stream,
                         redacts secrets from every event
```

Full architecture notes: [apps/swarmagents/README.md](apps/swarmagents/README.md). Product direction and decision record: [docs/architecture/focus-plan.md](docs/architecture/focus-plan.md) and [docs/architecture/master-plan.md](docs/architecture/master-plan.md). Principles: [docs/architecture/why.md](docs/architecture/why.md).

## What's inside

```
apps/swarmagents/            the app. This exact path is what the VPS deploy script syncs and builds.
  app/                       Next.js app router: pages and /api routes (runtime, providers, board, team, vm, ...)
  components/                shared React components (providers page, role cards, mascot)
  minimalist-ui/             the main workspace UI (composer, conversation, VM views, settings, team panel)
  lib/                       server logic: runtime/, harness/, providers/, router/, vm/, team/, board/, memory/, safety/, ...
  public/ branding/          static assets and brand sources (Git LFS for binaries)
  e2e/                       Playwright-style end-to-end specs
  deploy/                    VPS-side scripts (deploy, gate, backup, healthcheck, egress), nginx config, ship.sh
  vm-image/                  per-user VM image (Claude Code CLI + tools)
  vm-image-desktop/          optional desktop VM image (VNC, computer-use MCP)
  packages/swarm-node/       BYOC node agent: lets users bring their own machine as a VM
  packages/mcp-swarm-board/  standalone MCP server for the swarm task board
  tools/swarm-board/         board.sh, a CLI client for the live board
  vendor/                    STAGED SCRAPS, not part of the app (see below)
docs/                        architecture/, deploy/, playtest/, archive/ (index in docs/README.md)
.github/                     CI, manual Deploy and Playtest workflows, PR and issue templates
deploy.sh                    ./deploy.sh <action>: runs a whitelisted deploy action on the VPS over SSH
```

### vendor/: staged scraps

`apps/swarmagents/vendor/` holds snapshots of earlier projects that are waiting to be mined. Nothing imports them and they are excluded from typecheck, lint, tests and the Docker build. The plan: extract the useful parts into SwarmAgents through small PRs, then delete each folder.

| Folder | What it is |
| --- | --- |
| `vendor/omnexx/` | Omnexx: autonomous coding agent CLI + VS Code extension |
| `vendor/agl/` | AGL: S-expression agent language, runtime and primitive ledger |
| `vendor/claude-code-mini/` | Claude Code Mini: stateless small-context coding agent with key pooling |
| `vendor/swarmagents-repo/` | Leftovers from the earlier standalone repo: role registry, key clusters, racing engine, UI ideas |

## Self-hosting and deployment

Production deploys are built on the VPS from `main`, so **merge first, then deploy**. Deploying is a manual, owner-approved step.

1. **GitHub Actions:** Actions > **Deploy** > Run workflow > pick `deploy` (also `status`, `rollback`, `logs`, `cleanup`). Manual only, `main` only. It runs typecheck and unit tests first, then the VPS's forced command over SSH.
2. **From a shell:** `export DEPLOY_HOST=<host> DEPLOY_SSH_KEY=<path>`, then `./deploy.sh deploy` (or `status`, `rollback`, `logs`).
3. **Secrets** (repo or `production` environment): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`. Values are never in the repo; ask the owner. Setup details: [docs/deploy](docs/deploy/README.md).
4. **Gates before deploying:** `npm run typecheck`, `npm run test:unit`, `npm run lint`, `npm run build` in `apps/swarmagents`.
5. **Rollback:** run the workflow with `rollback` (restores the previous image and env). **Status:** run it with `status`.

**Playtest:** agents sign in to a shared test account that has provider keys loaded: `cd apps/swarmagents && npm run playtest:check` with `SWARM_TEST_EMAIL` / `SWARM_TEST_PASSWORD` set (and `playtest:seed` to load keys from the `TEST_*` secrets). The Playtest workflow does the same from Actions. Full guide: [docs/playtest](docs/playtest/README.md).

## Roadmap

Direction lives in [docs/architecture/focus-plan.md](docs/architecture/focus-plan.md) (the current decision record: one autonomous agent on its own computer, BYOC + BYOK, visible and sandboxed) and [docs/architecture/master-plan.md](docs/architecture/master-plan.md). Work in flight is tracked in pull requests and the internal task board.

## Contributing

Pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the PR flow, and the review gates. Agents working in this repo: read [AGENTS.md](AGENTS.md) first. Security issues: please report privately per [SECURITY.md](SECURITY.md), never as a public issue.

## License

[AGPL-3.0](LICENSE). Copyright (c) the SwarmAgents contributors.
