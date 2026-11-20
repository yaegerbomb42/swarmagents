# SwarmAgents

**One chat bar. One agent. Every tool. Nothing hidden.**

SwarmAgents is a web platform where you type a prompt and an agent works for you inside your own persistent Linux VM,
streaming every step (text, tool calls, results) live. It routes across many model providers with your own keys, and
exposes a task board that other agents can claim work from. Live at <https://swarmagents.codes>.

Repository: <https://github.com/yaegerbomb42/swarmagents>

## Deploy (agents: start here)

Production deploys are built on the VPS from `main`, so **merge first, then deploy**.

1. **GitHub Actions:** Actions > **Deploy** > Run workflow > pick `deploy` (also `status`, `rollback`, `logs`, `cleanup`).
   Manual only, `main` only. It runs typecheck and unit tests first, then the VPS's forced command over SSH.
2. **From a shell:** `export DEPLOY_HOST=<host> DEPLOY_SSH_KEY=<path>`, then `./deploy.sh deploy` (or `status`, `rollback`, `logs`).
3. **Secrets** (repo or `production` environment): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`.
   Values are never in the repo; ask the owner. Setup details: [docs/deploy](docs/deploy/README.md).
4. **Gates before deploying:** `npm run typecheck`, `npm run test:unit`, `npm run lint`, `npm run build` in `apps/swarmagents`.
5. **Rollback:** run the workflow with `rollback` (restores the previous image and env). **Status:** run it with `status`.

## Playtest

Agents sign in to a shared test account that has provider keys loaded: `cd apps/swarmagents && npm run playtest:check`
with `SWARM_TEST_EMAIL` / `SWARM_TEST_PASSWORD` set (and `playtest:seed` to load keys from the `TEST_*` secrets).
The Playtest workflow does the same from Actions. Full guide: [docs/playtest](docs/playtest/README.md).

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

`apps/swarmagents/vendor/` holds snapshots of earlier projects that are waiting to be mined. Nothing imports them and
they are excluded from typecheck, lint, tests and the Docker build. The plan: extract the useful parts into
SwarmAgents through small PRs, then delete each folder.

| Folder | What it is |
| --- | --- |
| `vendor/omnexx/` | Omnexx: autonomous coding agent CLI + VS Code extension |
| `vendor/agl/` | AGL: S-expression agent language, runtime and primitive ledger |
| `vendor/claude-code-mini/` | Claude Code Mini: stateless small-context coding agent with key pooling |
| `vendor/swarmagents-repo/` | Leftovers from the earlier standalone repo: role registry, key clusters, racing engine, UI ideas |

## Develop

```bash
cd apps/swarmagents
npm ci
npm run dev                       # http://127.0.0.1:3777
npm run typecheck && npm run test:unit && npm run lint && npm run build
```

Architecture overview: [apps/swarmagents/README.md](apps/swarmagents/README.md). Plan: [docs/architecture/master-plan.md](docs/architecture/master-plan.md).
Principles: [docs/architecture/why.md](docs/architecture/why.md).

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) | [AGENTS.md](AGENTS.md) (rules for agents) | [SECURITY.md](SECURITY.md)

License: none yet (all rights reserved until the owner chooses one).
