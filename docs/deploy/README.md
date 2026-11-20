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
