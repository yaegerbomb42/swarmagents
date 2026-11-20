# SwarmAgents Deployment & Gate Tools

This directory contains deployment automation and secure gate scripts for SwarmAgents prod on the Oracle VPS.

## Files

- `ship.sh`: the SSH client used by `./deploy.sh` and the GitHub Actions deploy workflow. It sends one whitelisted action to the forced command and nothing else.

- `deploy.sh`: Production deployment manager running directly on the VPS (`/home/ubuntu/infra/apps/swarmagents/deploy.sh`; the server's directory name).
  - Modes:
    - `deploy`: Tags current image as `prev` (timestamped), backs up `.env.v2` and `docker-compose.server.yml`, refreshes local git mirror from GitHub via read-only deploy key, pulls/syncs `origin/main`, rebuilds `swarm-vm:claude` if `apps/swarmagents/vm-image` changed, rebuilds `swarm-vm:desktop` if `apps/swarmagents/vm-image-desktop` changed, builds `swarmagents-v2:latest`, updates `SWARM_GIT_SHA`, brings up the compose project with `up -d --no-build`, polls `/api/health` for up to 90 seconds, and rolls back on failure. Concurrency is guarded with `flock`. Upon health check success, runs automated `cleanup`.
    - `build-desktop`: Pulls latest code and builds `swarm-vm:desktop` from `apps/swarmagents/vm-image-desktop`.
    - `desktop-on`: Backs up `.env.v2`, sets `SWARM_VM_DESKTOP=1`, restarts containers, verifies `/api/health`, and rolls back `.env.v2` on failure.
    - `desktop-off`: Backs up `.env.v2`, removes `SWARM_VM_DESKTOP`, restarts containers, verifies `/api/health`, and rolls back `.env.v2` on failure.
    - `cleanup`: Prunes old `swarmagents-v2` images (keeps `latest`, `prev`, and 3 newest `prev-<timestamp>` tags), prunes dangling docker images, trims `.env.v2.bak-*`, compose `.bak-*`, and `v2-src-prev-*.tgz` to the 5 newest of each, and reports disk space freed.
    - `status`: Queries `/api/health` and lists running containers and images.
    - `rollback`: Restores the latest `prev` image tag along with latest backup files and restarts services.
    - `logs`: Prints the last 200 log lines from the container with sensitive credentials/secrets/tokens redacted.
- `deploy-gate.sh`: SSH forced command gate (`/home/ubuntu/infra/apps/swarmagents/deploy-gate.sh`).
  - Reads `$SSH_ORIGINAL_COMMAND`.
  - Whitelists only `deploy`, `status`, `rollback`, `logs`, `build-desktop`, `desktop-on`, `desktop-off`, and `cleanup`.
  - Disallows any other command and enforces non-interactive execution when restricted via `~/.ssh/authorized_keys`.

## Validating `nginx.conf`

`apps/swarmagents/deploy/nginx.conf` is **an `http`-context snippet, not a full
`nginx.conf`**: it starts with a top-level `map` and one `server` block, both of
which are only legal inside `http {}`. That is why `nginx -t -c deploy/nginx.conf`
fails on a bare config and why the file went unvalidated for so long — it is
meant to be included, either as `/etc/nginx/conf.d/swarmagents.conf` or via an
`include` from `sites-enabled`.

Validate it for real without installing nginx (Docker must be running):

```bash
# 1. A throwaway wrapper that gives the snippet its http {} context.
mkdir -p ~/nginx-validate
printf 'events {}\nhttp {\n    include /etc/nginx/conf.d/swarmagents.conf;\n}\n' \
  > ~/nginx-validate/nginx.conf

# 2. Syntax check. Expect "syntax is ok" and "test is successful".
docker run --rm --entrypoint nginx \
  -v "$PWD/deploy/nginx.conf:/etc/nginx/conf.d/swarmagents.conf:ro" \
  -v "$HOME/nginx-validate/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx:1.27-alpine -t
```

Two notes:

- Bind-mount paths must live in a directory Docker Desktop shares (your home
  directory), not `/tmp`, or the mount fails with "not a directory".
- `-v` needs **absolute** host paths; `$PWD` must be `apps/swarmagents`.

Last verified 2026-11-18 against `nginx:1.27-alpine`: `syntax is ok`, `test is
successful`. The preview WebSocket mapping was also exercised against stub
upstreams: `GET /preview/<port>/` reaches 3777, the same request with
`Upgrade: websocket` reaches 3778, `/desktop/` reaches 3778, and `/` reaches
3777.

## Production rate-limit proxy config

- Deploy `apps/swarmagents/deploy/nginx.conf` (or equivalent) so nginx strips client-supplied `X-Real-IP`/`X-Forwarded-For` and sets them from `$remote_addr`.
- Set `SWARM_TRUST_PROXY=1` and `SWARM_TRUSTED_PROXY_HOPS` in the production env (e.g. `.env.v2`) to match trusted proxy hops.
