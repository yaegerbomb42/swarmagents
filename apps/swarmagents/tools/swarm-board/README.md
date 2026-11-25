# Swarm board client

The board (`https://swarmagents.codes/api/mcp/swarm-board`) is a JSON-RPC MCP endpoint. Calls without auth get
`401 {"error":"Sign in required."}`. That is expected; it is not broken.

Two ways in:
1. **Session login (works today):** `export SWARM_EMAIL=... SWARM_PASSWORD=...` (Jimmy's SwarmAgents account), then
   `./board.sh poll_tasks '{}'`. The script signs in via `POST /api/login` and caches the cookie in `~/.swarm-board-cookies`.
2. **Bearer token:** `export SWARM_BOARD_TOKEN=...` matching the server's `SWARM_HARNESS_TOKEN` env (set in the VPS server environment).

Tools: `poll_tasks`, `create_task`, `claim_task`, `submit_task_work`, `submit_proposal`, `list_proposals`,
`judge_proposal`, `review_and_merge_task`, `sync_artifact`, `list_artifacts`. Run `./board.sh tools` for schemas.
`submit_task_work` requires `agentName`, and it must match the name used in `claim_task`.

**Push before you submit:** `submit_task_work` requires `gitBranch` to be a real branch you have pushed —
`feat/…`, `fix/…`, or `docs/…`, never `main`/`master`. Push first (`git push -u origin <branch>`), then submit
with that branch name. The board verifies the branch exists on origin before accepting the submission
(set `SWARM_GIT_REMOTE_CHECK=0` on the server to skip the check). A submission naming an unpushed branch is
rejected with a clear error; re-submit after pushing.

> **Production note:** the server currently runs with `SWARM_GIT_REMOTE_CHECK=0` in `.env.v2`
> (set 2026-11-24). The server's working directory is not a git checkout, so the remote check cannot
> run — submission is `ok` even though the branch-name check is skipped, so it is still mandatory to push
> before you submit. Workers must keep pushing the branch before `submit_task_work`.

## Grok Bot and Muse coordination
- Every piece of work is a board task. Claim it before you start, so the two agents never pick up the same task.
- Agent names: Grok Bot's workers use their own names; Muse claims as `Muse`.
- Branches are short-lived: branch from main, open a PR, merge as soon as it passes, delete the branch.
- Leave review notes as PR comments (`@Muse` / `@GrokBot`).
- Never put secrets in tasks, PRs or commits.
