# WHY.md: principles

SwarmAgents is the only project in this repository. These are the lessons it is built on.

- **You cannot one-shot huge apps.** Complex systems that work evolved from simple systems that worked.
  Ship a small thing that works, then grow it.
- **You cannot build in a desert and assume an oasis of people will flock.** Distribution, direct human
  utility and fast feedback loops matter more than scaffolding.
- **The harness should never work the builder.** Avoid autonomous bureaucracy (circuit breakers, lock
  managers, speculative agent scaffolding). The model is a high-leverage amplifier inside a simple, direct loop.
- **Quality over volume.** One merged, tested change beats ten open branches.
- **Short-lived branches.** Branch from `main`, open a PR, merge as soon as it is green, delete the branch.
  Every worker starts from the same `main`.
- **Everything is reachable through GitHub.** Any agent can clone, build, test and ship through pull
  requests and the Actions workflows. No hidden machine state.
- **Secrets never live in the repo.** Keys and passwords are repo secrets or server env, never files in git.

## What is deployed

- `https://swarmagents.codes` on an Oracle VPS: the container `swarmagents-dashboard` (image
  `swarmagents-v2:latest`) behind nginx with TLS, with per-user VM containers for the agent runtime.
- Deploys are built on the VPS from `origin/main` by the forced-command deploy script; see
  [docs/deploy](../deploy/README.md).

## Where code is going

- `apps/swarmagents/vendor/omnexx/` and `apps/swarmagents/vendor/swarmagents-repo/` remain as temporary read-only reference snapshots until any remaining optional pieces (`anchors`, `edit-recovery`, `nimble`, `cascade-router`) are either ported by PR or explicitly dropped.
- `vendor/claude-code-mini/` has been fully mined (context governor, AST slicer, log condenser, auto-test generator, locator + dependency radar) and removed.
- `vendor/agl/` and `tools/agl/` were audited and removed: an S-expression DSL with hardcoded prototype runners adds prompt/syntax overhead without beating SwarmAgents' native TypeScript harness, `SwarmRouter`, and `tool-forge-mcp`.
- Core runtime wiring now routes oversized `tool.result` outputs through `filterObservation` (when `autoCondenseLogs` is enabled), compresses `shadow-verifier` test logs (`filterObservation` on green runs, `testDigest` on failing runs), enforces full Stage 0 anti-cheat rules (multi-language skip markers, deleted tests, snapshot rewrites) in `diff-hygiene-gate`, and runs `.swarm/browser-gate.{yaml,yml,json}` via `BrowserControl` when present, alongside standalone `differential-tdr`, `ratchet`, and `redundant-read` modules.
