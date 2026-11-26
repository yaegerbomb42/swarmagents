# Harness A/B Evaluation

Benchmarks harness configurations end to end on agent tasks and gates
regressions with a Pareto rule. This is the Wave 4 Task 16 foundation:
later waves are measured against baselines produced here.

## What it is

- **Stratified suite** (`lib/eval/suite.ts`): 15 deterministic tasks in
  3 buckets — surgical (5, single-file fixes, ≤15 turns), feature (5,
  multi-file additions, ≤80 turns), long-horizon (5, 4+ interacting
  components). Every task is a self-contained fixture (no network, no
  external MCPs): starting code, grading tests, the correct solution, and
  a plausible-but-wrong fix. Each task records a pinned `repoCommit` so a
  future repo-pinned task (checkout at that commit, real bug, hidden
  grading tests) drops into the same shape.
- **Mock replay driver** (`lib/eval/driver.ts`): replays scripted,
  deterministic transcripts per task + profile (same task + profile
  always replays the same turns/tokens). What it *does* is real: it
  materialises the fixture, applies the scripted fix at the scripted
  turn, performs the scripted failing tool calls for real (counted as
  observed errors), and grades by actually running the fixture tests in
  the isolated directory. Token counts are replayed — that is the point
  of a replay driver. A live driver implements the same `AgentDriver`
  interface against the real harness.
- **Runner** (`lib/eval/runner.ts`): one isolated temp directory per
  task trial, destroyed and verified gone afterwards. Isolation is a
  pluggable `IsolationDriver`; a Docker driver can implement the same
  create/destroy contract later (no Docker on this machine).
- **Comparator** (`lib/eval/comparator.ts`): per-task aggregates (pass@1,
  mean tokens, p50/p95 turns), bootstrap 95% CIs (seeded, reproducible),
  and the Pareto gate — regression when the solve rate drops > 2% OR
  token burn rises > 15% without a statistically significant solve-rate
  gain.
- **Reports** (`lib/eval/report.ts`): `pareto-report.json` (machine
  readable) + `report.md` (PR summary table).

## Usage

```bash
# CI self-check: baseline vs baseline must be clean, baseline vs wasteful
# must trip the gate, all buckets run, no run directory leaks.
npm run eval:dry-run

# Compare two profiles (baseline | wasteful | broken), 3 trials per task.
npx tsx tools/eval-harness/run.ts --baseline baseline --candidate wasteful --trials 3 --out eval-out
# Exit 0 = PASS, 1 = REGRESSION, 2 = usage error.
```

Profiles: `baseline` (solves, cache-friendly), `wasteful` (solves,
~1.7x turns, ~1.9x input tokens, ~5% cache hits — a token regression),
`broken` (applies a plausible-but-wrong fix — a solve-rate regression).

## Adding a task

Add an entry to `EVAL_SUITE` in `lib/eval/suite.ts`: starting `files`,
a grading `test` (node:test, run with `node --test` in the run dir), the
`solution`, and a `broken` variant. The suite test
(`lib/eval/suite.test.ts`) verifies for every task that grading fails on
the starting code, passes on the solution, and fails on the broken
variant — a task that does not satisfy all three is rejected by the test.

## Multi-provider real-task desktop eval

`provider-tasks.ts` / `provider-runner.ts` / `provider-report.ts` are a
separate eval aimed at the core product loop: *Claude Code + SwarmAgents
solving general tasks across user-supplied providers*. While `suite.ts`
benchmarks **harness configurations** (A/B, scripted transcripts), the
provider eval benchmarks **tasks** (coding, web, file organization, GUI
apps, non-vision desktop) and records completion rate, turns, tokens, and
wall-clock **per provider**.

```bash
# CI-safe deterministic run (scripted executors), provisions a FakeVmDriver:
npx tsx tools/eval-provider/run.ts --providers anthropic,openai --vm fake --out eval-out
# Local/manual: use a real Docker desktop VM (not available in CI):
npx tsx tools/eval-provider/run.ts --providers anthropic --vm docker
```

- The runner isolates every trial in a fresh temp dir (same `LocalTempIsolation`
  contract as the harness A/B eval) and grades with the same `node --test`
  grading step, so the metric pipeline is identical.
- Providing a `VmDriver` (FakeVmDriver in CI, DockerVmDriver locally) makes the
  runner also provision each trial into the VM and verify the VM ends in the
  solved state — the "runnable against FakeVmDriver / Docker desktop VM"
  path.
- A `ScriptedProviderExecutor` replays a deterministic solve per task for
  stable CI/tests. A live executor can implement the same `ProviderExecutor`
  interface against the real runtime.

## Relation to the capability-atlas eval

`lib/capability-atlas/eval` benchmarks capability *retrieval* accuracy
(which tool a query maps to). This harness benchmarks *harness
configurations* end to end on agent tasks. Different question, different
tool; neither replaces the other.
