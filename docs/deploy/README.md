# Deploy

SwarmAgents production (<https://swarmagents.codes>) runs on an Oracle VPS. A deploy **builds on the VPS from `main`**, so merge first.

## Steps

1. Make sure the change is merged to `main` and CI is green.
2. Run it, either:
   - **GitHub Actions:** Actions > **Deploy** > Run workflow > `deploy`. Manual, `main` only. Typecheck and unit tests run first.
   - **Shell:** `export DEPLOY_HOST=<host> DEPLOY_SSH_KEY=<path to key>` then `./deploy.sh deploy`.
3. Watch the log: the server builds the image, brings it up, polls `/api/health?ready=1` for up to 90 s and rolls back on failure.
4. Verify: run the workflow (or `./deploy.sh status`) with `status`.

Other actions: `rollback` (restore the previous image and env), `logs` (last 200 redacted lines), `cleanup` (prune old images and backups),
`build-desktop`, `desktop-on`, `desktop-off`.

## Required secrets

Set under Settings > Secrets and variables > Actions (repo, or a `production` environment with optional reviewers). Never commit values.

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | private half of a dedicated ed25519 deploy key |
| `DEPLOY_HOST` | VPS host or IP (ask the owner) |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <DEPLOY_HOST>` |

The key is restricted on the VPS by a forced command, so it can only run the whitelisted actions above.
One-time key setup, the server-side contract (what the VPS script reads from this repo) and everything else:
[apps/swarmagents/DEPLOY.md](../../apps/swarmagents/DEPLOY.md). VPS scripts: [apps/swarmagents/deploy/](../../apps/swarmagents/deploy/README.md).

## Safety

- Deploy workflows run only on manual dispatch from `main`, never for pull requests or forks.
- The `apps/swarmagents/` path is read by the VPS script; do not move it.

## One-time server cutover (owner, on the VPS)

The installed server script `deploy/deploy.sh` builds from a bare git mirror and a worktree that still point at the earlier private repo.
The deploy key is locked to a forced command, so these steps must be run by the owner in a normal SSH session. Because this repo has a fresh
history, the mirror needs a forced fetch and the worktree a hard reset (once). The repo is public, so no key is needed to fetch.

```bash
cd /home/ubuntu/repo
git -C monolith.git remote -v                       # note the current origin, for rollback
git -C monolith.git remote set-url origin https://github.com/yaegerbomb42/swarmagents.git
git -C monolith.git fetch origin +main:main         # + forces: histories differ
git -C monolith-worktree remote -v                  # expect origin = ../monolith.git (the mirror)
git -C monolith-worktree fetch origin
git -C monolith-worktree reset --hard origin/main   # one time only; later deploys use --ff-only
git -C monolith-worktree log --oneline -1           # should show the latest swarmagents main commit
```

Then verify with Actions > Deploy > `status`, and deploy normally. The directory names stay as they are (`monolith.git`, `monolith-worktree`,
`monolith_deploy_key`): they are server paths in the installed script, not repo names. Rollback of the cutover: set-url back to the old origin and
`git -C monolith.git fetch origin +main:main`, then reset the worktree to `origin/main` again.

Secrets for this repo (Settings > Secrets and variables > Actions, preferably under a protected `production` environment): `DEPLOY_SSH_KEY`,
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`. For playtests also `SWARM_TEST_EMAIL`, `SWARM_TEST_PASSWORD`, `TEST_<PROVIDER>_API_KEY`, and the
variable `TEST_PROVIDERS_MANIFEST`.
