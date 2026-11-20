# team-engine (Hydrogen)

A self-contained Team Mode **orchestration engine** written by Hydrogen
(Gemini), ported from its `agent-team-orchestrator` package. It is **not wired
into the UI or the runtime yet.** It is here so whoever finishes board task
x3 (Team Mode, branch `feat/x3-ada-team-mode`) can use it instead of writing
the scheduler again.

## What it is
`new TeamOrchestrator({ runner, clock, store }, config?)`

- `run({ runId, goal, baseWorkdir, budget, maxConcurrency })`:
  1. A planner agent returns a JSON plan, which is validated with zod. The plan
     has at most 12 tasks, unique ids, no unknown or cyclic `dependsOn`, and
     invalid plans are retried up to `maxPlanRetries`.
  2. Tasks run as a DAG with up to `maxConcurrency` running at once. Each task
     has its own workdir: `<baseWorkdir>/<taskId>` by default, or whatever
     `resolveWorkdir` returns.
  3. A reviewer agent accepts or rejects each result. A rejection retries the
     task with the feedback, up to `maxTaskRetries`.
  4. Changed-file conflicts between tasks are detected. A replan is triggered
     on failure, up to `maxReplans`.
  5. A merge summary is produced.
- Global token and USD budget, checked mid-stream. When it runs out, the
  orchestrator aborts every live agent through its `AbortSignal` and ends with
  `budget_exceeded`.
- Takeover: `pauseForTakeover(runId, taskId)` and
  `resumeFromTakeover(runId, taskId, { result?, changedFiles?, instructions?, skipReview? })`.
  Also `cancelAgent`, `cancelTeam`, and `resume(runId)` from the persisted
  `Store` state.
- Every step emits a `TeamEvent` (`team.plan`, `task.started`, `task.review`,
  `task.retry`, `team.done`, …) with a monotonically increasing `seq`, via
  `subscribe(runId, listener)`.

Everything external is injected. `AgentRunner.start(request)` returns an async
iterable of `thinking | tool | result | error | done` events. `Store` is
load/save, and `MemoryStore` is included. `Clock` is injected too. There is no
I/O, provider code or VM code inside.

## Compared with the x3 approach (Ada's port of swarmagents PR #4)

| | team-engine (this) | x3 / PR #4 `lib/team` |
|---|---|---|
| Scope | Engine only: scheduling, review loop, budget, takeover, events | End-to-end: engine, provider rotation, per-user slots, VM workspaces, API routes, TeamPanel UI |
| Plan shape | DAG with `dependsOn`, 1–12 tasks, replanning | 2–4 parallel lanes, one task per lane |
| Concurrency | Per run (`maxConcurrency`) | Per user (`acquireUserSlot`, default 3) and per provider quota |
| Budget | Tokens and USD, enforced mid-stream with abort | Per-run token and cost caps |
| Review | Reviewer verdict, retry with feedback, conflict detection, replan | Reviewer merge/rework |
| Takeover | Pause and resume one task with a human result or instructions | Desktop take-over in the panel |
| Persistence | `Store` interface, resumable from saved state | In-memory run registry |
| Tests | 9 unit tests (fake runner, deterministic clock) | Unit tests and 2 Playwright e2e tests |

Suggested fit: x3 keeps its UI, routes, per-user slot limiter and provider
rotation. It can use `TeamOrchestrator` as the scheduler by implementing
`AgentRunner` over `lib/harness/runner.ts`. Each `start()` would run Claude in
the user's VM with `workdir = /workspace/team/<runId>/<taskId>` and map stream
events to `thinking/tool/result/done`. It would also implement `Store` over the
run store and forward `TeamEvent`s into the telemetry bus.

## Caveats
- `changedFiles` comes from the runner's result event. The engine trusts it and
  never looks at the filesystem, so a real runner must compute it, e.g. with
  `git diff --name-only` in the lane's workdir.
- "Merge" is a summary of files and conflicts. It does not merge any git
  branches.
- The planner and reviewer prompts interpolate the user's goal and task results
  verbatim. Model output only becomes action through the zod-validated plan and
  verdict schemas, but prompt injection between lanes is still possible.

## Changes from Hydrogen's original
- Dropped the `.js` import suffixes to match the app.
- `orchestrator.ts`: re-read `task.status` un-narrowed after the worker stream
  ends. The original failed `tsc` (2× TS2367), because TS had narrowed the
  status to `'running'` across an `await` even though `pauseForTakeover` and
  `cancelAgent` can change it in the meantime.
- Test 5 (budget exhaustion): the fake runner checked `signal.aborted` after a
  `yield`. The engine aborts the signal and then stops iterating, which calls
  `return()` on the generator, so that code never ran. The check is now in a
  `finally` block. The engine was right and the test was wrong.
- The tests were ported from vitest to `node:test` through
  `lib/testing/vitest-compat.ts`.
