# SwarmAgents: One Thing — Focus Plan

> **Repository note (2026-11-21):** the canonical repo is now the public `yaegerbomb42/swarmagents` (the monolith is a frozen private archive), and the consolidation described below landed 2026-11-19/20. The inventory section describes the pre-move state and is kept as the decision record.

**Decision (James, 2026-11-19):** screw it. Clear the monolith of everything that isn't SwarmAgents. One product, full focus, all compute/talent/effort into shipping one thing. No more hidden features, no more work that does nothing.

**The one thing:** a completely autonomous task-solving system that competes with Devin and Manus — an agent with its own computer, BYOC + BYOK, free to use, and visibly autonomous: you watch it open Blender, run Python files, and do the work.

**The bet:** given any general task, the same model inside SwarmAgents beats the same model inside Codex, Copilot, Claude Code, and Antigravity — on token efficiency, completion rate, turns, or time per task.

## Rules (James's, non-negotiable)

1. **Every task ships something visible or measurable.** A UI change you can see, a video, or a number. If it produces neither, it doesn't ship.
2. **No new apps in the monolith. No work on removed code.**
3. **One component gets the perfection budget: the running daemon.** Everything else is "good enough, copy the frontier."
4. **The system must keep building and booting through the whole consolidation.** Never break SwarmAgents to clean it.
5. **Backup before deletion.** Nothing is removed until the pre-consolidation tree is saved on a branch/tag.

## Inventory (verified 2026-11-19 via GitHub API)

- Repo: `yaegerbomb42/monolith` (private), **2.7 GB**, main head **`cd7a4b4e`** — "feat(swarmagents): unify swarmagents with mynow glass UI, remove swarmagents-v1, merge all PRs" (2026-11-19 16:52 UTC). Main is moving today; consolidation branches from this head and re-checks it before landing.
- `apps/` has **10 entries**: dweebs, forma, journal, kitbash, mynow, mynow-extension, omnexx, pulsebreaker, stickshot, swarmagents.
- `tools/`: agl, ripe-cli.sh. `packages/`: mcp-swarm-board. `infra/` + `.infra/`: deploy. `docs/`: ARCHITECTURE.md, DEPLOY.md.
- `mini` (Claude Code mini, <8k tokens/turn) — status 2026-11-19: NOT found as a named module in the monolith (see M1.2). Verify where it actually lives before claiming the harness path.
- `mynow`'s glass UI was already unified into swarmagents per the head commit — verify, then the `apps/mynow` + `apps/mynow-extension` code is dead and goes.
- ⚠️ **`api_keys.md` sits at the repo root.** A file with that name in a repo is a secrets risk. Do not just delete it — check whether it holds real keys, rotate anything in it, and purge it from git history.

### Keep / remove

| Keep | Why |
|---|---|
| `apps/swarmagents` | The product. Mini lives inside it (location still being verified — see M1.2). |
| `tools/agl` | Internal language — used by SwarmAgents where it provably saves tokens; cut any piece that doesn't. |
| `packages/mcp-swarm-board` | Board infra the workers use. |
| `docs/`, `infra/` (trimmed) | Only what deploys and documents SwarmAgents. |
| `README.md`, `WHY.md`, `AGENT_PROMPT.md` | Rewritten to the one-thing vision. |

| Remove (after backup) | Note |
|---|---|
| `apps/dweebs`, `apps/forma`, `apps/journal`, `apps/kitbash`, `apps/mynow`, `apps/mynow-extension`, `apps/omnexx`, `apps/pulsebreaker`, `apps/stickshot` | 9 apps out. `apps/omnexx` is the Omnexx landing page only — deleting it does not touch the real Omnexx repo (`yaegerbomb42/omnexx`). |
| `tools/ripe-cli.sh` | Verify first — move it into swarmagents if it serves it, else remove. |
| `gemini.md`, `agent_mod_requests.md` | Verify, then archive or remove. |
| `api_keys.md` | Secrets handling above — rotate + purge from history, don't just delete. |

**After consolidation there is one app (swarmagents) + one internal tool (agl) + the board package.** The "3-4 apps" resolve to one system.

## Phase 0 — Inventory & safety

- **M0.1 One line per app.** For each of the 10 apps: what it is, what it does, whether SwarmAgents needs any of it. (Mostly done above from the tree; confirm `forma`, `journal`, `kitbash`, `pulsebreaker`, `stickshot`, `dweebs` have no SwarmAgents dependency.)
- **M0.2 Backup branch.** Tag/branch the pre-consolidation tree (`archive/pre-consolidation-2026-11-19` at `cd7a4b4e`) so every removal is recoverable.
- **M0.3 Secrets check.** Read `api_keys.md` (never print its contents anywhere), rotate any live keys in it, purge it from history.
- **M0.4 Freeze.** No new work lands on removed code from this point. Board workers stay in drain mode until the consolidation lands.
- **Done when:** the keep/remove table above is confirmed line by line, the backup branch exists, and no live secret remains in the repo.

## Phase 1 — Consolidation (clear it out)

- **M1.1 Remove the 9 apps.** Delete `dweebs`, `forma`, `journal`, `kitbash`, `mynow`, `mynow-extension`, `omnexx`, `pulsebreaker`, `stickshot` from the monolith in one consolidation branch. Verify after each deletion that `apps/swarmagents` still builds. Status 2026-11-19 ~14:20 CST: DONE by Muse alone (Grok parked by James) — branch `feat/consolidation-remove-dead-apps`, commit `0100584b`, apps/ on the branch is exactly ['swarmagents']. CI is red on the branch, but main's CI was already red on the same head before the deletion, so the failure is very likely pre-existing; the exact failing step is unconfirmed (log download timed out, approval lapsed). Merge to main needs James's say-so. Note: main has moved twice since the branch was cut (#215 mini merge 18d2b01b, #217 omnexx merge 683ee7c) — the branch needs a rebase onto current main before merging; the deletions don't overlap either import, so the rebase is clean.
- **M1.2 Mini is the harness.** Verify the Claude Code mini path (<8k tokens/turn) is intact inside `apps/swarmagents` and is the default path a run takes. Fix or cut anything that routes around it. Status 2026-11-19: mini is NOT findable as a named module in the monolith (code search for `claude-code-mini` returns 0 hits; no file named mini). The harness lives in `lib/harness/runner.ts`. Inspection done 2026-11-19 ~14:35 CST: runner.ts (930 lines) has NO token budget — no maxTokens, no 8000, no budget constant; only an `error_max_turns` result subtype. `claude-code-mini` also returns 0 hits in the separate `yaegerbomb42/swarmagents` repo, and `maxTokens` there is only generic provider plumbing. Conclusion: the <8k tokens/turn mini does NOT exist as code in either repo. M1.2 is now a build-or-locate decision: either the <8k/turn budget gets built as a harness feature in Phase 1, or James points to where the mini code actually lives. RESOLVED 2026-11-19 ~16:37 CST: Grok recovered it from the published npm package claude-code-mini@0.3.0 (original folder deleted from James's Mac, never committed) and opened PR #215 (branch feat/claude-code-mini-import, tools/claude-code-mini/, 31 files, +2,683, mergeable, not merged). The 8,192-token limit is confirmed in src/contextGovernor.ts (MAX_TOTAL_TOKENS = 8192). Muse reviewed the PR: PASS — keys removed (benchmark_keys.md gone, only REDACTED placeholders in the code), pure addition, no overlap with apps/swarmagents or the consolidation deletions. ⚠️ The public npm package still exposes 13 Mistral + 9 NVIDIA keys — James must revoke them and unpublish/deprecate 0.3.0. Merge decision pending James.
- **M1.3 AGL goes internal.** Wire AGL in as SwarmAgents' internal agent language only where it measurably saves tokens on real runs. Any AGL piece that doesn't earn its place gets cut, not kept "for later."
- **M1.4 Omnexx extraction. Correction 2026-11-19:** `apps/omnexx` in the monolith is only the static landing page — there is nothing to extract from it, and it is removed with the other dead apps (see M1.1). If extraction is wanted, it targets the separate `yaegerbomb42/omnexx` repo (provider adapters, harness pieces) as its own task. Update 2026-11-19: the yaegerbomb42/omnexx repo is GONE (404) — the newest copy was on James's Mac (~/Projects/omnexx, main fac3784). Grok imported it as-is into tools/omnexx/ as PR #217 (1,521 files, +226,349); Muse reviewed it PASS (verified it is fac3784's tracked files; no live secrets in the scanned 900 files incl. all of src/ + test/). **MERGED 2026-11-19 ~16:50 CST (James's order) as 683ee7c; tools/omnexx/ is on main.** **Integration seam: worker harness, NOT a shared kernel package** — port the mini's governor+slicer into lib/harness as the L1 packer, port Omnexx's System-1 scorer + provider pool as small bounded modules, adopt keep-only-green as a harness behavior, build the daemon in SwarmAgents informed by Omnexx's daemon; keep tools/omnexx + tools/claude-code-mini as REFERENCE implementations, not runtime dependencies. The 4 unmerged Mac branches (feat/autonomous-daemon-hardening-clean, feat/autonomous-daemon-hardening, feat/vscode-ui-visual-testing, feat/sandbox-container-env) are NOT in PR #217 — follow-ups if wanted.
- **M1.5 One system that builds and boots.** After consolidation: `apps/swarmagents` builds, boots, and runs a task end to end. Docs and deploy trimmed to SwarmAgents only. README states the one-thing vision in one paragraph.
- **Done when:** the repo contains only the keep list, the app builds/boots/runs a task, and the diff is reviewable (deletions + the AGL moves, nothing else).

## Phase 2 — UI: copy the frontier, then stop

- **M2.1 Copy what frontier apps look like.** Layout, components, and feel modeled on the best agentic apps (Claude Code / Codex / Antigravity patterns): live screen front and center, a short running summary of what the agent is doing, input bar, provider state. Familiar, not novel.
- **M2.2 No more UI work after this.** UI is done when it looks like the frontier. Further time goes to the daemon, not to more screens.
- **Done when:** a first-time user can watch a run, read what it's doing, and take over — without a tour.

## Phase 3 — The daemon (the one component that gets perfected)

- **M3.1 Daemon spec.** One running daemon: lifecycle, sandbox, and the agent's own computer. It is the product; everything else serves it.
- **M3.2 BYOC + BYOK.** Your computer, your keys. Free to use — nobody else is doing both. This is the differentiator; make it true and obvious.
- **M3.3 Pure autonomy, fully visible.** Nothing hidden behind the scenes. The live screen shows the agent opening Blender, running Python files, using the computer. Computer takeover works when you want it; the agent keeps working when you don't.
- **M3.4 Sandboxed, so autonomy is safe.** Full autonomous decision-making is allowed because everything runs sandboxed — the agent cannot damage the host. Prove the sandbox boundaries with tests, not claims.
- **Done when:** a run can be watched start to finish on the live screen, takeover works, and the sandbox holds under adversarial attempts to escape it.

## Phase 4 — Local decision model (1–3B)

- **M4.1 Find the model.** Evaluate small local models (1–3B) for the agentic loop's decision points: continue / retry / ask / stop. Measure decision quality and latency, not vibes.
- **M4.2 Wire it in.** Loop decisions that don't need the big model get auto-processed locally. The big model only gets called when the small one can't decide.
- **Done when:** a measurable share of loop decisions is handled locally with no drop in completion rate, and tokens per task fall.

## Phase 5 — Prove it (benchmarks)

- **M5.1 Benchmark harness.** Same model, same tasks, different harnesses: SwarmAgents vs Codex vs Copilot vs Claude Code vs Antigravity.
- **M5.2 The four numbers.** For every task: tokens per task, completion rate, turns per task, time per task. Publish the table.
- **M5.3 Fix what loses.** Whatever metric loses gets a milestone of its own. No benchmark is run once and forgotten.
- **Done when:** SwarmAgents wins on at least one of the four metrics across the task set, and loses on none by a wide margin — with the numbers public.

## Phase 6 — Success stories (trajectories of odd tasks)

- **M6.1 Ship 3–5 trajectories.** Real, odd, general tasks solved end to end — the kind of thing that shows autonomy, not a demo script. Each one: video of the live screen + transcript + tokens/time/cost.
- **M6.2 Publish them.** On swarmagents.codes, where a visitor can watch the agent do the work.
- **Done when:** a stranger can watch three trajectories and believe the system does real work alone.

## Phase 7 — Launch & activate the workers

- **M7.1 Free to use.** Ship BYOC + BYOK, free. Monetization later — or ads while it works. No payments built before launch.
- **M7.2 Grok's workers (after consolidation). PARKED 2026-11-19 ~14:14 CST — James: "forget using grok bot for now just do it yourself."** The drafted activation prompt is dead; do not forward it. If James re-enables Grok later, the prompt needs re-drafting against the consolidated repo.
- **M7.3 My workers.** The board workers come out of drain mode onto this plan's tasks once the board is reachable again (board API has returned 401 "Sign in required" since 2026-11-16; drain mode holds until James decides the fix).
- **Done when:** the system is live, free, and both worker fleets are working the same task list.

## Distribution — the operative plan

The distribution plan is `swarmagents-distribution-plan.md` (same folder). It is the plan Muse and Grok carry out together: fix the front door (public site, README, LICENSE, X account), build the launch assets (60–90s hero video, 3–5 trajectories, benchmark table, sub-minute try-it path), seed the audience for 2–3 weeks, then compress the launch into 48 hours (Product Hunt, X, Show HN, Reddit). Grok cannot read this workspace — forward him the file when he is to carry out a phase. The launch waits until the daemon works and the trajectories + benchmarks exist.

## The ship plan — the execution sequence

`swarmagents-ship-plan.md` (same folder) is the plan to make SwarmAgents shippable and better than Muse, Grok Bot, Devin, Claude Code, and Manus: the competitive bar (four metrics, same model, same tasks), the five integration seams (model-agnostic loop, mini context budget, Omnexx System-1 scorer, kernel pieces, provider pool), and seven phases (foundations → harness → adversarial verification → daemon → local decision model → benchmarks → trajectories → launch) with a ship gate. The mini is verified building from the clean main copy (tsc exit 0); the one test failure is the keypool looking for repo key files — keys must come from per-user provider config, never repo files.

## The implementation plan — the stronger sequence

`swarmagents-implementation-plan.md` (same folder, written 2026-11-19 ~17:48 CST after the sprint was cancelled) is the execution sequence that actually gets somewhere positive: verified current state, one step at a time with a checkpoint after each, the board fix before any fleet work, the harness core before the daemon, and the benchmark on ONE task early — so the first positive result (a table proving the new harness beats the old one) lands before the long build. It is executable by Muse alone; the workers are an accelerator, not a dependency.

## Open questions for James

1. `tools/ripe-cli.sh` — does it serve SwarmAgents? (Move it in or remove it.)
2. `api_keys.md` — do you know what's in it? (It needs rotation + history purge if it holds live keys.)
3. `mynow-extension` — anything in it worth keeping, or is it dead now that the glass UI is unified into swarmagents?
4. Monetization timing — free at launch, ads-or-paid later. Confirm no payments work is built before launch.

## What "done" means for the whole plan

One repo, one app, one daemon. A stranger can open swarmagents.codes, watch an agent solve an odd task on its own computer, see the tokens/time it took, and believe the benchmark table. That's the product. Everything else was scaffolding.

## Refocus note (2026-11-21)

The Swarm Board is not a feature of SwarmAgents. Its only use is internal coordination of the work that builds SwarmAgents. The product is a single agent running on a VM, completing users' tasks better than Grok Bot and Muse, free, powered by the user's own provider quota and compute (BYOK + BYOC). Board-as-feature work, scoped workspaces, and multiplayer/spectator ideas are out of scope. The share room (watch-only), trajectories, and the daemon stay: they serve single-agent visible autonomy.
