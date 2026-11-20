# Omnexx "Antigravity" copy (archive)

A second full Omnexx checkout was found at `~/.gemini/antigravity/scratch/omnexx` (remote `github.com/yaegerbomb42/omnexx`, which no longer exists).
It was compared against `vendor/omnexx` (a snapshot of Omnexx `main@fac3784`, 2026-11-09, v1.0.0).

## Verdict: `vendor/omnexx` is the newer and fuller copy

| | Antigravity copy | `vendor/omnexx` (`main@fac3784`) |
|---|---|---|
| Last commit on `main` | `e52d634`, 2026-11-05 | `fac3784`, 2026-11-09 |
| `package.json` version | 0.24.0 | 1.0.0 |
| Commits on `main` | 548 | 717 |
| Tracked files | 1282 | 1522 |
| Relationship | `e52d634` is an **ancestor** of `fac3784` (same root `583e01b`, 2026-10-03) | contains everything on Antigravity `main` |

(Earlier note said the lineages diverged: they do not. `fac3784` is simply 169 commits ahead of `e52d634`.)

Antigravity's 57 local/remote-tracking branches were also checked. 48 commits are not reachable from any imported ref, but 43 of those are
pre-squash variants of work that is already in `main` (checked by patch-id, subject and file presence: System-1 gates, context planner, bento/glass UI,
token budget, migrate wizard, planner/executor contract, swarm bug-fix batch, browser cockpit, etc.).

## What was genuinely missing, now added
Branch `feat/recursive-scope` (local only in Antigravity, 5 commits, 2026-10-25):

| Commit | Content |
|---|---|
| `6521cf35` | Task checkpoint resilience & survivability (`src/core/checkpoint.ts`, chaos test) |
| `5385eb59` | Recursive scope context architecture (`src/agent/recursive/*`) + A/B bench |
| `11e012b0` | `bench:recursive` npm script |
| `7c5add59` | `bench/live-ab-run.ts` + real metering-proxy logs (Ollama) |
| `99efe160` | `bench/run-nemotron-143.ts` + NVIDIA Nemotron results |

* **New files** (no conflicts) were promoted into `vendor/omnexx` proper: `src/agent/recursive/**`, `src/core/checkpoint.ts`,
  `bench/{ab-recursive,live-ab-run,run-nemotron-143}.ts`, `docs/recursive-scope.md`, `test/chaos/survivability.test.ts`,
  `test/unit/agent/recursive/**`, `test/unit/core/checkpoint.test.ts`.
* **Wiring edits** (`src/agent/loop.ts`, `src/cli/commands/{run,control}.ts`, `src/cli/program.ts`, `src/config/schema.ts`, `src/core/{cycle,exec,plan,report,run,supervisor}.ts`,
  `src/git/{repo,rollback}.ts`, `package.json`, `WHY.md`, bench results and logs) stay in `feat-recursive-scope-5-commits.patch`. They were written against Omnexx
  `dc89d544` and will need a manual 3-way merge on `fac3784`.
* Nothing here is wired in or built (`vendor/` is excluded from the app's tsconfig).

The complete Antigravity repo is also kept offline as a `git bundle --all` (`omnexx-antigravity-20261120.bundle`, 16 MB) next to the other Omnexx bundles.
