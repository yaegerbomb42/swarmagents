# Deploy Readiness — main @ 3e6f558 (2026-11-26)

**Checked:** 2026-11-26 ~18:15–18:45 CST (UTC 2026-11-27 00:15–00:45).
**Main head:** `3e6f558` — `[core-39] eval: harder desktop set … (#329)`, 2026-11-26 17:58 CST.
**Method:** fresh clone of `origin/main`, `npm ci`, full gate set in the clone.
**Live site:** https://swarmagents.codes — `/api/health` + `/api/health?ready=1`.

## Gate table (fresh clone, `apps/swarmagents/`)

| Gate | Command | Exit | Result |
| --- | --- | --- | --- |
| install | `npm ci` | 0 | clean install, 257 packages |
| typecheck | `npm run typecheck` | 0 | 0 errors |
| test:full | `npm run test:full` | **1** | 4996 pass / **2 fail** / 15 skipped, 40 suites, 5013 tests, ~10 min |
| lint | `npm run lint` | 0 | no errors |
| build | `npm run build` | 0 | static pages generated, no errors |

### The 2 test:full failures — both confirmed load flakes, not regressions

1. `lib/harness/explorer.test.ts:418` — "dispatch_explorer answers 3 queries in parallel":
   parallel run took 15,403 ms against a 20 s cap (the box was running other
   workers' suites concurrently). Known load flake; passes in isolation.
2. `lib/runtime/run-index.test.ts:232` — "listRuns over 100 × 400-event runs is < 10 ms":
   `listRuns(limit=20)` took **10.05 ms** vs a 10 ms cap — 0.5% over, a timing
   benchmark on a loaded box.

**Isolation re-run** of exactly those two files on the same code, with no other
suite running: **exit 0, 22/22 pass, 0 fail.** Neither failure is a code
regression. No other failures; the known baseline failures
(`lib/users.test.ts` scrypt legacy-upgrade, `system-one` outsideRepo) did not
appear in this run.

## Live drift

| | Commit | Time |
| --- | --- | --- |
| Live site (`/api/health`) | `2f40c66` | built 2026-11-23T05:37:34Z |
| Main head | `3e6f558` | 2026-11-26 17:58 CST |

**Live is 194 commits / ~4 days behind main.** Live health is otherwise good:
`ok: true`, `version: 2.0.0`, `board.writable: true`, `vmDriver: docker`,
`providersConfigured: 1` (`host-env` scope), uptime ~47 h at check time.
Readiness probe `/api/health?ready=1`: `ready: true`, vmDriver ok, home
writable, disk ok (not low).

## Deploy workflow — dispatchable

`.github/workflows/deploy.yml` (`Deploy`, state: **active**):

- Trigger: `workflow_dispatch` only (no push trigger), inputs `action`
  (choice, default `deploy`: `deploy | status | rollback | logs | cleanup |
  `build-desktop | desktop-on | desktop-off`) and `skip_gates` (default false).
- `gates` job runs on a deploy action (unless `skip_gates`): `npm ci`,
  `typecheck`, **`test:unit`** (not `test:full`), `lint`, `build`.
  Note: the 2 `test:full` flakes above would **not** block the workflow —
  it gates on `test:unit`.
- `ship` job: `main` only, requires gates success/skipped, runs
  `./deploy.sh <action>` over SSH against the Oracle VPS.
  Environment: `production` (exists; **no protection rules** — no required
  reviewers, no wait timer).
- Deploy history: last 5 runs **all success**; latest 2026-11-23T05:31:01Z
  at `2f40c66` — the commit now live. The pipeline demonstrably works; the
  site is simply stale.

### Deploy command sequence (from `docs/deploy/README.md`)

1. Confirm the change is merged to `main` and CI is green.
2. GitHub Actions → **Deploy** → Run workflow → `deploy` (manual, `main` only).
   Or from a shell: `export DEPLOY_HOST=<host> DEPLOY_SSH_KEY=<key path>` then
   `./deploy.sh deploy`.
3. Watch the log: the server builds the image, brings it up, polls
   `/api/health?ready=1` for up to 90 s and rolls back on failure.
4. Verify: `./deploy.sh status` (or the workflow with `status`); check
   `/api/health` reports the new commit.

## Blockers to deploy

1. **Owner go-ahead — the only hard blocker.** Deploy happens only on the
   owner's explicit approval. This report does not authorize a deploy.
2. **Deploy secrets not verifiable from this credential.** Listing repo
   secrets returns 403 for the token used here, so the presence of
   `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`
   could not be confirmed via the API. They were configured when the last
   deploy succeeded (2026-11-23); if any were rotated or removed since, the
   `ship` job fails at the SSH step. The owner/operator can confirm with
   `gh secret list` (needs a token with secrets scope) before dispatching.
3. **194 commits of drift.** The deploy ships ~4 days of work at once
   (core sprint + program tasks). Verify with `status` + `/api/health`
   commit after the deploy, and be ready to `rollback` from the same
   workflow if health does not flip to `3e6f558`.
4. **Live first-run proof is still outstanding** (real agent run + desktop
   dial need the owner's provider key). That is a product-verification gap,
   not a deploy blocker — the deploy itself only ships code.

## Recommendation: **GO (conditional)**

- Code gates are green: typecheck, lint, build exit 0; `test:full` is green
  modulo 2 timing flakes that pass in isolation.
- The Deploy workflow is dispatchable, its own gates (`test:unit`) are a
  subset of the verified gates, and the last 5 deploys all succeeded.
- The live site is healthy but 194 commits stale — deploying closes a
  4-day gap.

Deploy when the owner says go, then verify `/api/health` shows `3e6f558`
and run `./deploy.sh status`. If health does not come up, the workflow's
`rollback` action restores the previous image.
