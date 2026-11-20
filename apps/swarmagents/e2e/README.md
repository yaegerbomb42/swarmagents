# SwarmAgents E2E / Playwright smoke suite

Plain `node:test` specs driven by `playwright-core`, run with `tsx`.

## Prerequisites

Install Chromium for `playwright-core` once (it does not download a browser automatically):

```bash
npx playwright-core install chromium
```

Or point the suite at an existing Chromium binary:

```bash
PW_CHROMIUM_PATH=/usr/bin/google-chrome npm run test:e2e
```

Start the app separately, then run the suite:

```bash
npm run dev
npm run test:e2e
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://127.0.0.1:3777` | App under test |
| `SWARM_E2E_MODE` | `local` | `local` or `prod` |
| `SWARM_VM_DRIVER` | `fake` | Local runs use the fake VM; set `docker` for a real sandbox. |
| `SWARM_FAKE_CLAUDE` | enabled | Set `0` to stop FakeVmDriver replaying the recorded `claude` stream-json transcript. |
| `SWARM_CODEBASE_LOCAL_ROOT` | unset | Local mode only: build the Codebase map from this checkout on the server's filesystem instead of from the fake VM (which has no repository). Used by the codebase spec so it can exercise the treemap. |
| `SWARM_HARNESS_TOKEN` | unset | Bearer token for server-mode auth. Read from the environment only and never logged. |
| `SCREENSHOT_DIR` | `/workspace/swarmagents-playtest/<timestamp>` | Screenshot and `summary.json` output directory |
| `PW_CHROMIUM_PATH` | `playwright-core` default | Existing Chromium executable |

Example local run:

```bash
BASE_URL=http://127.0.0.1:3777 SWARM_E2E_MODE=local \
SCREENSHOT_DIR=/tmp/swarm-e2e npm run test:e2e
```

Example production smoke run (read-only):

```bash
BASE_URL=https://swarmagents.codes SWARM_E2E_MODE=prod \
SWARM_HARNESS_TOKEN="$SWARM_HARNESS_TOKEN" npm run test:e2e
```

Production mode is strictly read-only. The browser blocks non-GET/HEAD/OPTIONS
requests and the dispatch spec is skipped.

## Specs

- `smoke.spec.ts` - home page status, no uncaught page errors or `console.error`,
  input bar and computer screen render, `/api/mcp/swarm-board` JSON, and
  `/api/health` when it exists.
- `views.spec.ts` - terminal, browser, and telemetry views with a screenshot per view.
- `dispatch.spec.ts` - local mode only. Submits a prompt from the input bar; the
  fake VM replays a recorded stream-json transcript through the real runtime, and
  the spec waits for `run started`, the assistant text, and `run finished` in the
  terminal.
- `approvals.spec.ts` - local mode only. Sends a prompt containing `rm -rf /`,
  which makes the fake claude emit a risky Bash tool call. Asserts the approval
  card appears, Deny resolves it to `denied` with a run error, and Allow resumes
  the run to `run finished`.

Every test writes a full-page screenshot (pass or fail) plus an entry in
`SCREENSHOT_DIR/summary.json` with `test`, `status`, `error`, and `screenshot`.

## Typecheck

```bash
npx tsc -p e2e/tsconfig.json
```
