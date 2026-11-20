# vendor/swarmagents-repo: what the old standalone `swarmagents` repo had that this repo did not

The public repo `yaegerbomb42/swarmagents` (Nov 10-12 2026) was an early "unified platform" attempt: the old Next.js
dashboard (`apps/web`), a copy of the Omnexx engine (`packages/engine`), a provider layer (`packages/providers`),
the Omnexx VS Code extension and a small CLI. Almost all of it is already in this repo or its history (the dashboard
is commit `462da5a49`; the extension and most engine files match `vendor/omnexx`; Team Mode, PR #4 there, is already
ported as `lib/team`, `lib/team-engine` and the Team panel). This folder keeps only the pieces that were **not**
anywhere in this repo. It is a reference snapshot: excluded from tsc, eslint, tests and the Docker context, nothing
imports it. Paths below mirror the old repo (`main@d4712b6`).

| Path here | What it is | Why it might matter |
| --- | --- | --- |
| `packages/engine/src/roles/` (16 files, with tests) | Declarative role registry: YAML role files, loader, validate, merge, filter, `bind` into the agent loop (tool whitelist, permissions, clamps) | The app's `lib/roles.ts` is a UI catalog; this is enforcement. Candidate for the harness |
| `packages/engine/src/llm/{key-cluster,clusters}.ts` | Per-provider key clusters (Nemotron/Mercury style) with concurrent racing and rotation, env-driven (`<P>_API_KEYS`) | Compare with `lib/providers/run-pool.ts` before porting |
| `packages/providers/src/{raceEngine,keyPool}.ts` | Multi-key racing engine with tests | Racing the same call across keys; the router has hedging but not this |
| `packages/engine/src/swarmagents-bridge.ts`, `telemetry/efficiency.ts`, `bench/efficiency*` | Engine to web bridge, run-efficiency metrics | Telemetry ideas |
| `packages/engine/src/{agent,autonomous,core,tools/extra,telemetry}` modified files | Omnexx 1.0.0 engine files that were **changed** in that repo (provider give-up cap, abortable tool race, state-store and atomic-write fixes, web search rewrite) | `omnexx-engine-modifications.patch` is a unified diff against `vendor/omnexx/src`. Mine it in step 2 |
| `apps/web/src/components/swarm/{SwarmGrid,AgentRoleCard,ConsensusReplay}` + css and tests | Swarm topology grid, role cards, consensus replay UI | Old Tailwind 3 stack; reuse the ideas, not the code, in `minimalist-ui` |
| `apps/web/src/components/console/*`, `app/console/page.tsx`, `hooks/*` | Minimal prompt bar, provider pill, live telemetry feed | Early minimal-UI concept |
| `apps/web/src/lib/sandbox/*`, `lib/tools/webBrowser*`, `lib/{omnexxBridge,harnessTasks,eventBus,auth,providerTemplates}.ts`, `app/api/harness/task/route.ts` | Browser-side "virtual VM" hook, web browsing tool, harness task API | Superseded by the real per-user VM; kept for reference |
| `apps/cli/src/index.ts` | Tiny CLI runner | Reference |

Related notes live in `../../../../docs/archive/swarmagents-repo/` (the old README and the agent handoff briefs).
No keys, tokens or `.env` files were imported; the old repo's own scan results are in the PR that added this folder.
