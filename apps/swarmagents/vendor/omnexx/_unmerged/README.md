# Omnexx unmerged work (archive)

Everything from Jimmy's local Omnexx repos (`~/Projects/omnexx` and `~/omnexx-clone`) that was **not** already in `vendor/omnexx`
(a snapshot of Omnexx `main@fac3784`). The GitHub `omnexx` repo no longer exists, so these patches are the record.
A full `git bundle --all` of both repos is also kept offline.

Nothing here is applied or built. Patches are `git format-patch --binary` mbox files; apply with `git am` (or `git apply --3way`)
from the `vendor/omnexx` root against Omnexx `main@fac3784` (some will conflict because `main` moved on; that is why they are here).

## Promoted into `vendor/omnexx` proper (new files only)
From `feat/token-governor` (`516f1e43`, `bdddf458`): `bench/report.ts`, `bench/runners/opencode.ts`, `bench/suites/long5/**` (5 real-PR tasks),
`docs/USAGE.md`, `src/usage/{ledger,report}.ts` and their tests. The edits that wire them in (`bench/index.ts`, `bench/types.ts`,
`src/agent/*`, `src/core/*`, `src/config/*`, `package.json`) conflict with later `main`, so they stay in the patch below.

## `branch-patches/`
| Patch | Source | Notes |
|---|---|---|
| `feat-token-governor-2-commits.patch` | `feat/token-governor` | Per-task spend caps + usage ledger; long5 bench. Wiring edits not applied. |
| `vscode-ui-visual-testing-7-commits.patch` | `feat/vscode-ui-visual-testing` | Alternative VS Code webview overhaul + screenshot harness (parallel to merged PR #430, so conflicts). Includes PNG screenshots (base85). |
| `autonomous-daemon-24-7-846ee45.patch` | `feat/autonomous-daemon-24-7` | Original 24/7 daemon commit. `main` has a reworked version; kept for reference. |
| `perf-speculative-neural-caching-5b09826.patch` | `perf/speculative-neural-caching` | Cache pinning/tracking, AST cache, speculative checks. `main` has a reworked version. |
| `git-snapshotter-385b669.patch` | `feat/git-snapshotter` = `backup/concurrent-385b669` | GitTreeSnapshotter + history compaction (steps 3.5/3.6). Branch was stale; check against `main` before reuse. |
| `rogue-docs-master-todo-91295e2.patch` | `backup/rogue-docs-91295e2` | MASTER_TODO ledger update (28/71 steps). |
| `old-origin-master-cache-meter.patch` | `origin/master` | Unrelated early history (cache-meter telemetry). |

Already equivalent to `main` (not exported): `feat/autonomous-daemon-hardening(-clean)`, `feat/sandbox-container-env`, `feat/eslint-autofix`.

## `omnexx-clone/`
`omnexx-clone-39-commits.patch`: all commits unique to the second clone (Oct 28): `feat/time-*` (time-budget phases 0-3), `research/autonomous-runtime`
(autonomous_improvements.md charter), `fix/vscode-model-chip-settings`, `fix/bug-batch`, `fix/vscode-provider-model-ui`, `feat/vscode-mode-presets`.
Time-budget phases 0-2 already landed in `main` under different SHAs; the rest is here for reference.

## `stashes/`
Seven git stashes from `~/Projects/omnexx` (VS Code chat/render WIP, composer statusline, subsystem-7 verify, etc.) as plain diffs. Mostly UI WIP; low value.

## `omnexx.toml.sample`
Jimmy's local autonomous-daemon config (no secrets). `.omnexx/` runtime state (autonomous.db, budget ledger, logs) and `.env` were deliberately NOT archived.

## `antigravity/`
Comparison with the third Omnexx copy (`~/.gemini/antigravity/scratch/omnexx`, v0.24.0, 2026-11-05) and the 5-commit `feat/recursive-scope` branch it alone had. See `antigravity/README.md`. Conclusion: `vendor/omnexx` is the newer, fuller copy.
