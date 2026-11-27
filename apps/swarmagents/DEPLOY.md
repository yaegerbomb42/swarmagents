# Deploying SwarmAgents

SwarmAgents is the only app in this repo and the only thing the VPS builds.

## How a production deploy works

Production is <https://swarmagents.codes> on the Oracle VPS (host in the `DEPLOY_HOST` secret, user `ubuntu`).

1. A deploy SSH key is restricted on the VPS by a **forced command** (`deploy/deploy-gate.sh`). It can only run
   one of: `deploy`, `status`, `rollback`, `logs`, `build-desktop`, `desktop-on`, `desktop-off`, `cleanup`.
2. `deploy` runs `deploy/deploy.sh` on the VPS. That script is installed on the server (it is **not** read from
   the repo at run time). It fetches `origin/main` through a read-only deploy key, fast-forwards its worktree,
   tags the current image as `prev`, rsyncs **`apps/swarmagents/`** from that worktree, builds
   `swarmagents-v2:latest` from `apps/swarmagents/Dockerfile`, brings the compose project up, polls
   `/api/health?ready=1` for up to 90 s, and rolls back automatically on failure. It rebuilds the
   `swarm-vm:claude` / `swarm-vm:desktop` images when `apps/swarmagents/vm-image` /
   `vm-image-desktop` changed **or the image is missing** (a fresh host has neither; the desktop
   image builds on top of the headless one, so the headless image is built first).
3. So **a deploy ships whatever is on `main`**. Merge first, then deploy.

What the server script depends on in this repo (do not move or rename without updating the server copy):

| Path in repo | Used for |
| --- | --- |
| `apps/swarmagents/` | rsync source and Docker build context (so the app must stay at this path) |
| `apps/swarmagents/Dockerfile` | the image build |
| `apps/swarmagents/vm-image/`, `apps/swarmagents/vm-image-desktop/` | per-user VM images, rebuilt when changed or missing |

Nothing else in the repo is read by the deploy. The server keeps its working directory under
`/home/ubuntu/infra/apps/swarmagents`; that directory name is a server-side path baked into
`deploy/deploy.sh` and `deploy/deploy-gate.sh`, and is the only remaining reference to that folder name. The server's git mirror, worktree and read-only deploy key also carry a legacy name (`monolith.git`, `monolith-worktree`, `monolith_deploy_key`) for the same reason: they are server-side paths in the installed script, not repo names.

Speed: the deploy is incremental. The Docker context excludes `vendor/`, `tools/`, `docs/`, `branding/`,
`deploy/`, `vm-image/` and `packages/mcp-swarm-board/` (`.dockerignore`), the `npm ci` layer is cached until
`package*.json` changes, and unchanged VM images are skipped.

## Canonical deploy shape

There is exactly one supported production topology. Every repo artifact that
mentions a port or a path must agree with this table; if you change a number,
change it everywhere it appears (`deploy/nginx.conf`, both compose files,
`HEALTH_URL` in `deploy/deploy.sh`, `deploy/healthcheck.sh`, `.env.example`).

The app container runs three servers in one process (all started from
`instrumentation.ts`): the Next.js app on container port **3777**, the
desktop proxy (`lib/desktop-proxy`) on **3778**, and the BYOC hub
(`lib/byoc`) on **3779**. Compose publishes them on the host as:

| Host port | Container port | Published on | Serves |
| --- | --- | --- | --- |
| 3400 | 3777 | all interfaces | Next.js app (UI + `/api/*` + `/preview/<port>/...` HTTP) |
| 3778 | 3778 | `127.0.0.1` only | desktop proxy: `/desktop/*` HTTP assets, `/desktop/ws`, preview WebSocket upgrades |
| 3779 | 3779 | `127.0.0.1` only | BYOC hub: `/byoc/ws` node dial-in |

For the loopback publishes to work, the two in-process servers bind
`0.0.0.0` **inside the container** (`SWARM_DESKTOP_PROXY_HOST=0.0.0.0`,
`SWARM_BYOC_HOST=0.0.0.0` in both compose files). The host-side bind stays
loopback-only, so the host nginx vhost is their only public entry. Never
publish 3778 or 3779 on a public interface.

The host nginx vhost (`deploy/nginx.conf`, installed as
`/etc/nginx/conf.d/swarmagents.conf` or included from `sites-enabled`)
routes by path:

| Public path | Upstream | Notes |
| --- | --- | --- |
| `/` | `127.0.0.1:3400` | the app; 3400 must match `HEALTH_URL` in `deploy/deploy.sh` |
| `/api/runtime/stream/…`, `/api/share/<token>/stream` | `127.0.0.1:3400` | SSE: `proxy_buffering off`, 24 h read timeout |
| `/desktop/` | `127.0.0.1:3778` | WebSocket upgrade headers, 24 h timeouts; session-cookie gate in the proxy |
| `/preview/` | `127.0.0.1:3400` for HTTP, `127.0.0.1:3778` for `Upgrade: websocket` | split by the `$preview_backend` map; Next.js cannot receive upgrades |
| `/byoc/` | `127.0.0.1:3779` | WebSocket upgrade headers, 24 h timeouts; node-token hello gate in the hub |

Every location sets `X-Forwarded-Host $host` (and strips client-supplied
`X-Forwarded-For` / `X-Real-IP`): with `SWARM_TRUST_PROXY=1` the app reads
the forwarded headers, so nginx must overwrite them, never pass a client's
values through.

**`deploy/deploy.sh` never touches nginx.** The vhost is installed and
reloaded by the operator. After any edit to the installed vhost:

```bash
nginx -t && systemctl reload nginx
```

**Verification checklist** (run on the VPS after a deploy or a vhost change;
`https://swarmagents.codes` below assumes TLS is enabled — substitute
`http://` while it is not):

```bash
# 1. App on its host port, and through nginx:
curl -s http://127.0.0.1:3400/api/health?ready=1
curl -s https://swarmagents.codes/api/health?ready=1

# 2. Desktop proxy answers on loopback and refuses the unauthenticated
#    request (401 = proxy reached, cookie gate up; the Host header is
#    needed because server mode checks it against SWARM_ALLOWED_HOSTS —
#    without it the proxy answers 403, which still proves it is listening;
#    connection refused = bad publish):
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: swarmagents.codes' \
  http://127.0.0.1:3778/desktop/

# 3. Desktop WebSocket through nginx reaches the proxy, not Next.js
#    (401 without a session cookie; 101 with one):
curl -s -i --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://swarmagents.codes/desktop/ws | head -1

# 4. Preview HTTP goes to the app (login redirect / 401 from Next.js) and a
#    preview WebSocket upgrade goes to the proxy (refused there, not by Next.js):
curl -s -o /dev/null -w '%{http_code}\n' https://swarmagents.codes/preview/3000/
curl -s -i --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://swarmagents.codes/preview/3000/ | head -1

# 5. BYOC hub accepts the upgrade (101; curl then waits for the hello frame,
#    hence --max-time). A plain GET without upgrade headers gets no answer —
#    the hub has no HTTP handler; that is expected, not a routing failure:
curl -s -i --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://swarmagents.codes/byoc/ws | head -1

# 6. SSE streams flush immediately (events appear as they happen, no
#    buffering delay; needs a real run id and a session cookie):
curl -s -N --max-time 10 -b 'swarm_session=<cookie>' \
  https://swarmagents.codes/api/runtime/stream/<runId>
```


## Deploying from your shell or from GitHub

From a machine that has the deploy key:

```bash
export DEPLOY_SSH_KEY=~/.ssh/swarm_deploy    # path to the private key (default)
./deploy.sh status      # or deploy | rollback | logs | cleanup | build-desktop | desktop-on | desktop-off
```

From GitHub: **Actions > Deploy SwarmAgents > Run workflow** (manual; runs on `main` only). For `deploy`
it first runs typecheck and unit tests, then runs the forced command over SSH. To deploy on every merge to
`main`, uncomment the `push:` trigger in `.github/workflows/deploy.yml`.

### Repo secrets the owner must set (Settings > Secrets and variables > Actions)

Create an environment named `production` (optionally with required reviewers), and add these as
**environment or repo secrets**. Do not paste values into issues, PRs or chat.

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | private half of a dedicated ed25519 deploy key (full file contents) |
| `DEPLOY_HOST` | the VPS host or IP (ask the owner) |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <DEPLOY_HOST>` (pins the host key) |

One-time VPS step for the key (the operator does this once; use a new key rather than reusing another one):

```bash
ssh-keygen -t ed25519 -N '' -C swarmagents-gha-deploy -f ./gha_deploy      # keep gha_deploy private
# On the VPS, append to ~/.ssh/authorized_keys (one line, forced command, no extras):
# command="/home/ubuntu/infra/apps/swarmagents/deploy-gate.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... swarmagents-gha-deploy
gh secret set DEPLOY_SSH_KEY < ./gha_deploy && rm ./gha_deploy ./gha_deploy.pub
```

## Installing the egress unit (one-time, on the VPS)

```bash
sudo install -m 755 apps/swarmagents/deploy/swarmagents-egress.sh /usr/local/sbin/swarmagents-egress.sh
sudo install -m 644 apps/swarmagents/deploy/swarmagents-egress.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable swarmagents-egress.service
```

---

## Container build

The app builds as a Next.js `standalone` server. `Dockerfile` is a
multi-stage build (`deps` → `builder` → `runner`); the runner image is
`node:22-bookworm-slim`, runs as the unprivileged `nextjs` user (uid 1001),
listens on `0.0.0.0:3777`, and declares `/data` as a volume. The runner
includes the Docker CLI (for the mounted host socket), Chromium (for
`BrowserManager`), and `tar` (for desktop VNC secret seeding).

```bash
docker build -t swarmagents-v2:latest apps/swarmagents
# Explicit demo mode (no per-user containers):
docker run --rm -e SWARM_VM_DRIVER=fake -p 3777:3777 -v swarm_data:/data swarmagents-v2:latest
```

Or use the bundled Compose file (named `swarm_data` volume mounted at
`/data`, so `SWARM_HOME=/data` persists board, users, and telemetry).
Compose runs the app in server mode by default, so a session secret is
required before the first start:

```bash
export SWARM_SESSION_SECRET="$(openssl rand -hex 32)"
export SWARM_ALLOWED_HOSTS="swarmagents.example.com"   # your public hostname
docker compose -f apps/swarmagents/docker-compose.yml up --build
```

### Server-mode authentication

Any deployment must run in server mode (`SWARM_SERVER_MODE=1`). In local
mode there is no login at all — anyone reaching port 3777 gets full access
to runs, VMs, provider keys, and the board — so the Compose files set server
mode by default and a plain `docker compose up` without a secret fails at
compose time instead of serving an unauthenticated app. Five variables:

- `SWARM_SERVER_MODE=1` — enables server-mode auth: every route except
  `/login`, `/about`, `/status`, `/api/login`, `/api/signup`, `/api/me`, and
  `/api/health` requires a signed session cookie or a `SWARM_HARNESS_TOKEN`
  bearer token. Local development (`npm run dev`) leaves it unset and keeps
  working unchanged.
- `SWARM_SESSION_SECRET` — HMAC key for session cookies, **32+ random bytes**
  (`openssl rand -hex 32`). The app refuses to boot in server mode when it
  is missing or empty — it fails at startup, not at the first login — and
  compose fails even earlier (`${SWARM_SESSION_SECRET:?…}`). Keep it stable:
  rotating it signs everyone out, and it is also the fallback key for
  sealing provider keys when `SWARM_KEYS_SECRET` is unset.
- `SWARM_ALLOWED_HOSTS` — comma-separated public hostnames the middleware
  host allowlist accepts (e.g. `swarmagents.example.com`). When unset,
  every `Host` header is denied in server mode (the only exception is
  loopback `/api/health`, which stays reachable for the Docker healthcheck),
  so set it in production — the app refuses to boot in server mode when the
  list is empty, rather than serving a site-wide 403. Entries may carry a
  port (`swarmagents.example.com:443`); ports are stripped before matching.
  If `SWARM_ALLOWED_HOSTS` is set, include the
  internal `swarmagents` hostname as well so VM approval callbacks are
  accepted (see below).
- `SWARM_COOKIE_SECURE` — session cookies are `Secure` (HTTPS-only) by
  default. **Pair this with how the app is reached:** with a TLS-terminating
  proxy in front (the production shape), leave it unset. On a deployment
  reached over plain HTTP, browsers silently drop Secure cookies — login
  returns 200, then every page bounces back to `/login` forever with no
  error shown — so set `SWARM_COOKIE_SECURE=0` there (and only there). At
  boot, server mode + Secure cookies + no `SWARM_TRUST_PROXY` logs a warning
  naming this pairing.
- `SWARM_PUBLIC_ORIGIN` — the public origin of the deployment (e.g.
  `https://swarmagents.example.com`). Required for real (Docker) runs in
  server mode: per-user VMs reach the app's LLM proxy and approval endpoint
  through it. When it (and the `SWARM_VM_LLM_BASE_URL` /
  `SWARM_VM_APPROVAL_BASE_URL` overrides) is unset, Docker runs are refused
  at start and the run-start error response names the missing variables
  (`missingEnv`). Non-Anthropic providers (OpenAI-style APIs) additionally
  *require* the proxy: the VM's Claude CLI speaks only the Anthropic
  Messages API, and direct mode would place the raw per-user key in the VM
  environment, so server mode refuses to start such runs without a proxy
  origin instead of silently falling back to direct mode. The
  `SWARM_VM_LLM_BASE_URL` / `SWARM_VM_APPROVAL_BASE_URL` overrides exist for
  deployments where VMs must reach the app at a different address than the
  public site (Docker bridge gateway IP, `host.docker.internal`); normally
  `SWARM_PUBLIC_ORIGIN` covers both.

Library moderation is a separate trust boundary: `SWARM_ADMIN_USERS`
(comma-separated user ids or account emails) names who may review and
unpublish public-library items. In server mode nobody is an admin until
it is set — set it on any deployment with a public catalog. See
`apps/swarmagents/.env.example` and the `README.md` environment-variables
table for the full list of production knobs (rate limits, BYOC port,
node home, cloud-pool capacity, test-drive sweep interval).

External MCP clients (including the swarm board at
`/api/mcp/swarm-board`) authenticate with `SWARM_HARNESS_TOKEN` as a
`Bearer` token; browser sessions use the signed cookie. Board reads and
writes both require one of the two in server mode — the board is no longer
publicly writable. See `apps/swarmagents/.env.example` for placeholder
values.

#### Sign-up posture (`SWARM_ALLOW_SIGNUP`)

Self-signup is **closed by default** in server mode (and whenever
`NODE_ENV=production`): `POST /api/signup` answers `403` ("Sign-up is
disabled on this server.") and the login page does not offer "Create
account". Local mode is the exception — it trusts loopback only, so
sign-up stays open there regardless of this variable.

- `SWARM_ALLOW_SIGNUP=1` (or `true`) — opens self-signup. This is the
  supported launch posture: flip the switch and anyone who can reach the
  site can create an account. Each account gets its own VM, so open
  sign-up spends real compute — before opening it, configure the abuse
  controls in "Email verification + bot check" below (verification
  email via SMTP, and the Turnstile bot check).
- `SWARM_SIGNUP_MODE=invite` — **invite-only sign-up**, the middle
  posture: the "Create account" toggle renders, but `POST /api/signup`
  additionally requires a valid code from `SWARM_INVITE_CODES`
  (comma-separated, case-sensitive). Codes are **single-use**: the
  account created with a code records only the code's keyed hash, and a
  spent code can never create a second account. Missing, unknown, and
  spent codes all get the same generic `400` ("A valid invite code is
  required to sign up.") — the response never distinguishes them, and
  codes are never logged. Invite mode takes precedence over
  `SWARM_ALLOW_SIGNUP` (the more restrictive explicit posture wins), and
  composes with the abuse controls below (bot check first, then the
  code, then account creation + verification email). Use long random
  codes (e.g. `openssl rand -hex 16` each) — anyone holding a code can
  create one account. With invite mode on but `SWARM_INVITE_CODES`
  empty, sign-up fails closed. Removing a code from the list stops
  future redemptions; it does not un-redeem a spent code. To issue more
  codes, append them to `SWARM_INVITE_CODES` and recreate the
  container.
- Unset / any other value — sign-up stays closed. To create accounts
  (including the first operator account on a fresh deployment) while
  sign-up is closed, set `SWARM_ALLOW_SIGNUP=1`, create the account(s),
  then unset it and recreate the container so the new environment takes
  effect.

The login page and the API share one predicate for this gate, so the
"Create account" toggle renders exactly when the API would accept a
sign-up (in invite mode: with a code).

#### Email verification + bot check (`SWARM_TURNSTILE_*`)

**Decision (FIX-44): unverified accounts cannot start runs.** They can
sign up, sign in, and configure providers, but in server mode
`RuntimeManager.start()` refuses until the emailed verification link
is clicked — so a fake sign-up consumes no VM compute. The alternative
(blocking sign-up itself until verified) was rejected: it strands the
account-creation flow on mail delivery and complicates the first-run
path. Local mode is never gated (single trusted user on loopback).
Accounts that predate verification (no `verified` field in
`users.json`) are grandfathered as verified, so existing deployments
do not lock out current users.

- Verification links are single-use, HMAC-stored `ev1.` tokens (24 h
  default, `SWARM_EMAIL_VERIFY_TTL_HOURS`), sent through the same SMTP
  transport as password reset — configure SMTP (next section) before
  opening sign-ups, or new users can never verify. A signed-in user
  who lost the email resends from `/verify-email`.
- Bot check: set `SWARM_TURNSTILE_SECRET` + `SWARM_TURNSTILE_SITE_KEY`
  (Cloudflare Turnstile) and the sign-up form requires a valid widget
  token, verified server-side before any account work. With the secret
  unset the check is skipped — acceptable for local mode and closed
  sign-ups, not for open ones.

#### Password-reset email (SMTP)

Password reset ("Forgot password?" on the login page) emails a
single-use reset link, and email verification (above) emails its link
through the same transport. It needs an SMTP transport — the app ships a
dependency-free SMTP client (`lib/mailer.ts`); any provider works
(Gmail app password, Fastmail, SES/Mailgun SMTP, a local relay):

- `SWARM_SMTP_HOST` — SMTP server host. **Required in server mode** for
  reset email to be deliverable.
- `SWARM_MAIL_FROM` — From address, e.g. `SwarmAgents <no-reply@example.com>`.
  Required alongside the host.
- `SWARM_SMTP_PORT` — default `587` (`465` when `SWARM_SMTP_SECURE=1`).
  On port 587 the client upgrades with STARTTLS when the server offers it.
- `SWARM_SMTP_SECURE=1` — implicit TLS from connect (port 465 style).
- `SWARM_SMTP_USER` / `SWARM_SMTP_PASS` — AUTH LOGIN credentials, when the
  provider requires them.
- `SWARM_SMTP_TIMEOUT_MS` — per-operation SMTP socket timeout in
  milliseconds (default `10000`; non-positive/invalid values fall back
  to the default). Raise it only for a slow relay.
- `SWARM_SMTP_HELO` — EHLO name the client presents (default: the
  container hostname). Set it when your provider/relay expects a
  specific EHLO identity (e.g. your server's FQDN).
- `SWARM_PASSWORD_RESET_TTL_MIN` — reset-link lifetime in minutes
  (default `30`). Links are single-use; asking for a new link kills the
  previous one, and a completed reset signs out every existing session.

Without `SWARM_SMTP_HOST`/`SWARM_MAIL_FROM` the request endpoint still
answers 200 (it must not reveal whether an account exists), but no email
is sent and a warning is logged — so configure mail **before** opening
sign-ups, or locked-out users have no recovery path. In local mode the
reset link is written to the server console instead, so a local operator
can still recover the account.

#### User store concurrency (`users.json`)

**Decision (FIX-45): cross-process file lock.** Every read-modify-write of
`users.json` in `lib/users.ts` (sign-up, session revocation, password
reset/change, email verification) runs under two locks: the in-process
promise lock that was always there, and an advisory lockfile
(`users.json.lock` next to the store, `lib/file-lock.ts`) that serializes
writers across processes. A second app process sharing the same
`SWARM_HOME`/data volume can therefore no longer silently drop another
process's account writes — the pre-FIX-45 store assumed one process, and
two writers loading the same snapshot would clobber each other.

Why not the alternatives:

- *Single-instance only* (document and enforce one process): leaves a
  silent data-loss footgun the day anyone runs a second process against
  the same volume (a rolling deploy, a stray dev server). The lock
  removes the hazard for ~100 lines.
- *SQLite*: needs a native dependency (or the still-experimental
  `node:sqlite`) plus a data migration, for a store with a handful of
  rows. Disproportionate today; revisit if the user count or write rate
  ever grows.

Limits that remain, by design:

- The lock is advisory and same-host: it serializes writers that go
  through `lib/users.ts` on a local filesystem. Do not hand-edit
  `users.json` while the app is running, and do not share the data
  volume over NFS or between hosts — stay on the single-host canonical
  deploy shape above, or move the store to a real database first.
- Sessions are stateless HMAC and were never the problem; they survive
  multi-process unchanged.
- A lock left by a crashed process is broken automatically once it is
  10 s old. A lock that cannot be acquired within 15 s fails the request
  (HTTP 500) instead of risking a clobbered write. Critical sections are
  milliseconds long, so either event means something is wedged — look
  for a stuck process before deleting `users.json.lock` by hand.

Both the `Dockerfile` and `docker-compose.yml` define the same readiness check.
It probes `http://127.0.0.1:$PORT/api/health?ready=1` (default `3777`) with
Node's built-in `fetch`. A probe passes only for HTTP 2xx **and** `ready: true`,
which checks the board, free disk, and the Docker daemon when the Docker VM
driver is selected. Bare `/api/health` remains the lighter liveness endpoint.

The probe necessarily connects over loopback, so its `Host` header is
`127.0.0.1:$PORT` rather than the public hostname. In server mode
(`SWARM_SERVER_MODE=1`) the middleware host allowlist would otherwise answer
`403` and Docker would report the container as `Up (unhealthy)` even though
`https://<public-host>/api/health` is fine. Middleware therefore exempts
loopback requests to `/api/health` only (`lib/auth.ts` + `middleware.ts`); every
other path still goes through `SWARM_ALLOWED_HOSTS`.

Reproduce the probe by hand:

```bash
docker exec swarmagents node -e "fetch('http://127.0.0.1:3777/api/health?ready=1').then(async (r) => console.log(r.status, await r.text()))"
docker inspect --format '{{json .State.Health}}' swarmagents | jq
```

### Optional Docker socket (VM driver)

The base Compose file defaults to `SWARM_VM_DRIVER=fake` for development and
needs **no** Docker socket. For real per-user VMs, use the supplied override;
it selects `docker`, mounts the socket, and puts both the app and VM containers
on the same Compose-managed `swarm-vms` network:

```bash
cd apps/swarmagents
export SWARM_SESSION_SECRET="$(openssl rand -hex 32)"
npm run vm-image:build
# Optional desktop VMs: npm run vm-image-desktop:build
# Linux: export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
# macOS: export DOCKER_GID="$(stat -f '%g' /var/run/docker.sock)"
# Nonstandard daemon-visible socket path:
# export DOCKER_SOCKET="/run/custom-docker.sock"
docker compose -f docker-compose.yml -f docker-compose.docker.yml up --build
```

The override also sets `SWARM_VM_APPROVAL_BASE_URL=http://swarmagents:3777`, so
VM approval hooks reach the app over that shared network. `SWARM_SESSION_SECRET`
is required. The default socket group `0` works only for root-owned sockets;
set `DOCKER_GID` to the actual socket group as shown (Colima commonly uses a
nonzero group). `DOCKER_SOCKET` overrides the daemon-visible host socket path
(the path must be mountable by the Docker daemon, not merely by the client).
For a
socket path when Docker is not available at `/var/run/docker.sock`. For a
manual/custom Compose setup,
the equivalent socket configuration is:

The socket is owned by `root:docker` with mode `0660`, so the app
container's user must be in the host's `docker` group — otherwise the mount
is there but unusable (`permission denied` on the socket). Pass the host
group id in explicitly:

```yaml
services:
  swarmagents:
    group_add:
      - "${DOCKER_GID}"     # on the host: getent group docker | cut -d: -f3
    volumes:
      - swarm_data:/data
      - /var/run/docker.sock:/var/run/docker.sock
```

Mounting the Docker socket grants the container control over the host daemon;
keep it out of fake-driver deployments. In server mode, if
`SWARM_ALLOWED_HOSTS` is set, include the internal `swarmagents` hostname as
well as the public hostname so the VM approval callback is accepted.

The current override and app image were validated against a real daemon:
`GET /api/health?ready=1` passed, the app container ran its Docker CLI and
Chromium, and a Compose-started agent completed Write/Edit/Bash work in a real
per-user VM on the shared network. The test containers, network, and volumes
were removed afterward.

### The per-user VM image (`swarm-vm:claude`)

The image the driver creates one container per user from is built from the
repo (`apps/swarmagents/vm-image/`), not by hand on the host:

```bash
cd apps/swarmagents
npm run vm-image:build     # docker build -t swarm-vm:claude vm-image
```

Then point the app at it:

```bash
SWARM_VM_DRIVER=docker
SWARM_VM_IMAGE=swarm-vm:claude
```

The image is `node:22-bookworm-slim` plus the standard agent tooling (git,
ripgrep, python3/pip/venv, uv/uvx, Chromium and Playwright MCP,
build-essential, jq, curl, ca-certificates, procps, less, unzip) and the
Claude Code CLI, pinned with the `CLAUDE_CODE_VERSION`
build arg. It runs as the unprivileged `node` user with `/workspace` owned by
that user, and it ships `/etc/claude-code/managed-settings.json` (read-only,
root-owned) which registers a `PreToolUse` approval hook and pre-allows only
non-secret read-only tools. The hook blocks each tool call until the harness
(`lib/harness/risk.ts`) returns allow/deny, so nothing executes before the
verdict: deny is returned to the model, ask waits for the user (300s timeout
= deny). The hook reachability is configured with `SWARM_VM_APPROVAL_BASE_URL`
(defaults to the LLM proxy origin) and signed per-run with
`SWARM_SESSION_SECRET`. Local real Docker runs are rejected at startup when
those settings are absent, because the managed hook cannot be safely replaced
by the legacy post-hoc stdout gate. For local reachability, Docker Desktop
normally uses `host.docker.internal`, while Linux uses the Docker bridge
gateway IP; the app or an approval-only reverse proxy must listen on that
interface (the VM's loopback is not the host). See `README.md` for the local
listener security guidance.

Rebuild and re-tag the image whenever the pinned CLI version or the tool set
changes; existing VM containers keep running the old image until they are
recreated (`docker rm -f swarm-vm-<user>` or a VM reset).

### The per-user desktop VM image (`swarm-vm:desktop`)

Desktop mode (`SWARM_VM_DESKTOP=1`) gives every user's VM a full Linux
desktop — XFCE on display `:1`, Chromium, a terminal and file manager, and a
browser-viewable VNC web client (noVNC) on the container's port 6080. The
desktop image builds on top of the headless one:

**Production default: ON (explicit decision).** The live VM screen is the
flagship surface, so the server template
(`docker-compose.server.yml.example`) ships `SWARM_VM_DESKTOP: "1"` (with
`SWARM_VM_MEMORY: "4g"`), and `deploy` builds `swarm-vm:desktop` when it is
missing — a fresh deploy from the template has a working desktop with no
extra steps. The state is never silent: `GET /api/health` always reports
`desktop`, `/api/health?ready=1` fails with `DESKTOP_IMAGE_MISSING` when
desktop mode is on but the image is gone (so a bad deploy rolls back
loudly), and the UI shows a "desktop off" notice in the stage instead of
silently substituting the terminal. To opt out (headless VMs, terminal
screen only), set `SWARM_VM_DESKTOP: "0"` in the server compose
environment — or run `./deploy.sh desktop-off` on the VPS, which edits
`.env.v2` — and recreate the app container. Local/dev keeps the opt-in
default (unset = off); see `.env.example`.

```bash
cd apps/swarmagents
npm run vm-image:build                # swarm-vm:claude (dependency)
npm run vm-image-desktop:build        # docker build -t swarm-vm:desktop vm-image-desktop
```

Enable it on the server:

```bash
SWARM_VM_DRIVER=docker
SWARM_VM_DESKTOP=1
SWARM_VM_DESKTOP_IMAGE=swarm-vm:desktop   # default
```

A container that already exists when desktop mode is turned on is recreated
from the desktop image automatically (the `/workspace` volume survives). Port
6080 is **never published to a host port**: the browser reaches it over the
docker network only, and the driver hands the app the container IP + the
per-container VNC password via `desktopEndpoint()`.

**RAM expectations.** A desktop container adds a GUI session and a browser to
the headless stack, so the per-VM memory ceiling should be raised from the
default `2g` — e.g. 4GiB per desktop VM — while keeping the hard ceiling so
one user's runaway browser cannot starve the host (all VMs share the host's
RAM):

```bash
SWARM_VM_MEMORY=4g        # per desktop VM; 2g is the floor
```

CPU and PID ceilings stay as configured (`SWARM_VM_CPUS` default `2`,
`SWARM_VM_PIDS` default `512`). Plan host sizing around the number of
concurrent desktop VMs × their ceiling — a single 4GiB desktop VM is roughly
the footprint of one heavy user machine.

### Warm VM pool (`SWARM_VM_WARM_POOL_SIZE`)

> **Not active in production yet.** Only the fake (test) driver implements the
> warm-pool capability. With the docker driver the setting is ignored and the
> app logs `[vm] SWARM_VM_WARM_POOL_SIZE=… is ignored` once at boot; leave it
> unset on the VPS until the docker driver gains prewarm/adoptWarm.

Cold-starting a desktop VM (Docker + Xvnc + XFCE + Chromium) takes several
seconds per new user. `SWARM_VM_WARM_POOL_SIZE` (default `0` = off) keeps a
bounded pool of pre-booted, unassigned VMs so a user's first `ensure()`
hands them a running container instead. After each hand-off the pool
replenishes asynchronously back to the bound.

Isolation is strict: at hand-off the VM gets a fresh `/workspace` volume
and a fresh VNC password before the user's first exec — no warm-phase
state can ever leak between users. A pool slot counts against host sizing
exactly like an active desktop VM (memory × pool size on top of concurrent
users), so size it deliberately — e.g. `SWARM_VM_WARM_POOL_SIZE=2` for a
small deployment that wants snappy first runs without doubling the RAM
ceiling. The pool engages only when the driver implements the
prewarm/adoptWarm capability (today: the fake driver, so tests prove the
contract); the docker and BYOC drivers cold-boot as before until they gain
the capability.

### VM network (`SWARM_VM_NETWORK`)

By default, VM containers are created on Docker's default bridge — the same
network every other container on the host uses. Egress filtering then
depends on nothing else using that bridge, which is fragile: one unrelated
container changes the blast radius.

Set `SWARM_VM_NETWORK` to put every VM container on a dedicated network
instead. The driver then creates the container with
`docker run --network <name>`; unset keeps the previous behavior.

Recommended setup:

```bash
docker network create \
  --driver bridge \
  --subnet 172.30.0.0/16 \
  swarm-vms
```

```bash
SWARM_VM_NETWORK=swarm-vms
```

The app container must also join this network. Otherwise approval callbacks
and the desktop proxy's direct connection to the VM IP can fail even though
`docker version` succeeds. `docker-compose.docker.yml` handles this by
attaching the app to `default` and `swarm-vms`, and by creating `swarm-vms`
automatically; a manual `docker network create` is only needed for a custom
deployment. In that case attach the app with `docker network connect
swarm-vms <app-container>` or declare the same network in its Compose service.

The dedicated subnet is what makes the egress rules enforceable: they can
target `172.30.0.0/16` (or the `swarm-vms` network) only, so nothing else
on the host is affected by them and nothing else can reach the VMs. The
`host` network is rejected by the driver — it would put every VM in the
host's network namespace and defeat the network-scoped rules entirely.

**Egress rules (in-repo).** The rules are implemented by
`deploy/swarmagents-egress.sh` (installed to `/usr/local/sbin/`) with the
boot-time unit `deploy/swarmagents-egress.service`
(installed once by the operator, see "Installing the egress unit" below).
The script is the single source of truth for the policy; the iptables
sketch below is only the shape of what it installs:

```bash
# Rule order inside DOCKER-USER matters: the accept rule has to come before
# the drop rule, so the accept is inserted at position 1 and the drop at 2.
# 203.0.113.0/24 is a placeholder: use the provider's published egress
# ranges (Anthropic / OpenAI / Gemini) for the hosts the agent may reach.
iptables -I DOCKER-USER 1 -s 172.30.0.0/16 -d 203.0.113.0/24 -j ACCEPT
iptables -I DOCKER-USER 2 -s 172.30.0.0/16 -j DROP
```

(`DOCKER-USER` is evaluated before the per-bridge `DOCKER` chains, so the
rule applies to containers regardless of the bridge they are on.) With
nftables the equivalent is an `ip` chain in the `inet` family matched on
`ip saddr 172.30.0.0/16`. Keep the rule set minimal and version-controlled
next to the deployment, and remember that the rule must survive daemon
restarts (a systemd unit or the host firewall manager owns it).

What the script actually enforces (per-user VM network only): block cloud
instance metadata (169.254.169.254, except DNS on :53, the VCN resolver),
the tailnet (100.64.0.0/10), private ranges (other containers, the host,
host-published ports via DNAT), and outbound mail submission (TCP 25/465/587).
Public internet stays open. It reads the VM subnet from the Docker network
`swarmagents-isolated` at deploy time, saves it to
`/etc/swarmagents-egress.subnet`, and reuses the saved subnet at boot (when
Docker is not up yet). It is idempotent — re-running it never stacks
duplicate rules. The deploy script verifies public HTTPS still works from
the agent container after applying the policy and removes the jump if it
does not.

### Per-VM resource limits

With the Docker driver, every per-user VM container is created with a hard
ceiling so one user's runaway process cannot starve the host:

| Env var | Default | Docker flag |
|---------|---------|-------------|
| `SWARM_VM_MEMORY` | `2g` | `--memory` |
| `SWARM_VM_CPUS` | `2` | `--cpus` |
| `SWARM_VM_PIDS` | `512` | `--pids-limit` |

Values are validated at startup: a malformed value aborts the Docker driver
with a `VmLimitError` instead of silently running an unbounded container. The
limits are re-applied (`docker update`) to containers that already exist, so
lowering a limit also affects VMs that were created earlier.

### Global concurrent-VM cap

Per-VM ceilings bound one container; `SWARM_MAX_CONCURRENT_VMS` bounds how
many user VMs may be live at once across all users (default `4`, sized for a
small VPS at the 4GiB desktop ceiling; `0` disables the cap). A run that
would need a fresh VM past the cap queues with a capacity status (its place
in line) instead of starting a container or OOMing the host, and starts
automatically when a slot frees. Idle-but-alive VMs count against the cap
until the idle sweeper hibernates them (`SWARM_VM_IDLE_MIN`, default 30), so
capacity turns over on that cadence; a user whose VM is already live is
never blocked by other users' VMs. Size it as host RAM ÷ per-VM ceiling,
leaving headroom for the app itself.

## Provider fleet config (SWARM_PROVIDERS_FILE)

Server-wide provider entries can be declared without code changes via
`SWARM_PROVIDERS_FILE` (a JSON file with a `providers` array; see
`providers.example.json` in this directory). At startup the file is read
once and its entries are migrated into the owner account's per-user
provider store (`SWARM_OWNER_EMAIL`), then the file is renamed
`providers.json.migrated` — so it seeds the initial fleet, after which keys
are managed per account in the UI/API. Schema validation (`lib/providers/config-file.ts`)
rejects entries with missing required fields (`id`, `kind`), unknown
`kind`/`apiStyle`/tier names, or non-string model tiers before anything is
migrated.

Ready-to-paste OpenAI-compatible entries for the two newer fleet providers:

| Provider | Base URL | `apiStyle` | Key env | Suggested tiers |
|----------|----------|------------|---------|-----------------|
| IteraCompute | `https://api.iteracompute.com/v1` | `openai-chat` | `ITERACOMPUTE_API_KEY` | pick from the IteraCompute console |
| EXAONE | `https://api.exaone.ai/v1` | `openai-chat` | `EXAONE_API_KEY` | default model `k-exaone_v2.5`; other tiers per the EXAONE model list |

Copy `providers.example.json`, replace the `<...-model-id>` placeholders
with exact model ids from the provider's console (exact ids are required at
run time; the placeholders exist so no stale ids ship in the repo), flip
`"enabled"` to `true` for the entries you filled in (the example ships them
disabled so an unedited copy never routes to a placeholder id), and point
`SWARM_PROVIDERS_FILE` at the file:

```bash
export SWARM_PROVIDERS_FILE=/data/providers.json
```

**Keys:** migration drops `envKeys` — a migrated provider is a per-user
provider and runs only use keys from the owner's sealed store
(`lib/providers/migrate.ts`, `lib/providers/user-run-pool.ts`). So an
exported `ITERACOMPUTE_API_KEY` / `EXAONE_API_KEY` is **not** used for runs;
the migrated entries arrive keyless. After the first start, add the key in
Settings → Providers (or `POST /api/providers`). The `envKeys` names in the
table only feed the host health probe (`lib/providers/health.ts`).

Never commit real keys: `keys` arrays are omitted from the example entirely.

## Desktop stream proxy

The user's live desktop must be reachable only through the app behind login,
and Next.js route handlers cannot upgrade WebSockets. The desktop stream is
therefore served by a small dedicated Node HTTP proxy (`lib/desktop-proxy/`)
that starts inside the app process (from `instrumentation.ts`, alongside the
Next.js standalone server) on an **internal** port, 127.0.0.1:3778 by
default. The proxy itself implements the auth and ownership gates:

- Every request (HTTP assets and WebSocket upgrades) must carry a valid
  session cookie (`lib/auth`); unauthenticated requests get 401.
- The only upstream target is `getVmManager().desktopEndpoint(userId)` for the
  authenticated user — the container's IP on its docker network at port 6080.
  Client-supplied host/port/path/query never influence the dial target, so
  there is no SSRF surface via headers or params.
- The VNC password is injected server-side: the proxy terminates the RFB
  handshake toward the container (VNCAuth) while presenting a passwordless
  handshake to the browser. The password never appears in any response, URL,
  or log.
- Sessions are `view` (read-only) by default — enforced both by the upstream
  `viewonly=1` flag and by the proxy dropping RFB input messages
  (key/pointer/clipboard) in view mode. `control` is granted only when the
  client explicitly requests takeover (`?mode=control`), and at most one
  control session per user exists at a time.
- Per-user cap of 3 concurrent sessions (default, `SWARM_DESKTOP_MAX_VIEWERS`)
  and a 10-minute idle timeout (`SWARM_DESKTOP_IDLE_MS`).
- Session opens are recorded in the audit log as `desktop.view` /
  `desktop.takeover`.

Disable the in-process proxy (e.g. when running a separate instance) with
`SWARM_DESKTOP_PROXY_DISABLED=1`. The proxy can also run standalone on its
own port: `npm run desktop-proxy:dev` (or `node dist/desktop-proxy/desktop-proxy/server.js`
after `npm run build`, which compiles the proxy tree to `dist/desktop-proxy`).

**Frame tap (opt-in).** `SWARM_DESKTOP_FRAME_TAP=1` makes the proxy
composite each session's RFB stream into a framebuffer shadow and store
JPEG keyframes on significant screen damage (≥2% of tiles changed, or any
change after 30 s). Keyframes are readable, session-gated, at
`GET /desktop/keyframes` (list), `GET /desktop/keyframes/<id>`, and
`GET /desktop/keyframes/at/<ts>`; they are retained briefly after a
session closes so a finished run's screen can still be scrubbed. The tap
also feeds the frame reference in takeover handback summaries and the
`desktop.damage` run telemetry. Only the exact value `1` enables it —
unset (the default) constructs no tap at all and costs nothing. While
enabled, budget up to ~2× framebuffer plus a bounded keyframe store
(320 frames / 32 MiB) per tapped session. Stored keyframes are
downscaled to a largest dimension of 1280 px by default (aspect
preserved); set `SWARM_DESKTOP_KEYFRAME_MAX_DIM=0` for full-resolution
storage, or another positive value for a different cap.

### Routing `/desktop/` in production

The proxy listens on the container loopback only. To reach it from the host's
nginx, bind it to the container's interface and publish it on the host
loopback:

```yaml
# docker-compose.server.yml (swarmagents service)
environment:
  SWARM_DESKTOP_PROXY_HOST: 0.0.0.0   # proxy binds inside the container
ports:
  - "127.0.0.1:3778:3778"              # published on host loopback only
```

Then nginx on the host routes the public path to it. The WebSocket upgrade
must be passed through explicitly. A reference config (including the main app
proxy and safe client-identity headers for rate limiting) lives in
`apps/swarmagents/deploy/nginx.conf`; strip and re-set `X-Real-IP` /
`X-Forwarded-For` from `$remote_addr` so clients cannot spoof them:

```nginx
# /etc/nginx/sites-available/swarmagents.conf
location /desktop/ {
    proxy_pass http://127.0.0.1:3778;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400s;   # long-lived desktop sessions
    proxy_send_timeout 86400s;
}
```

For production, set `SWARM_TRUST_PROXY=1` and `SWARM_TRUSTED_PROXY_HOPS=1`
(adjust hops to match the number of trusted proxies in front of the app) so
anonymous rate limits key off the real client address instead of a shared
fallback.

The `location /desktop/` prefix covers both the HTTP assets (`/desktop/*`,
proxied to the container's VNC web client) and the WebSocket connection
(`/desktop/ws`). No other path ever reaches the proxy. The host firewall
should not expose 3778 anywhere but the loopback; the published port binding
above enforces that. SSL termination happens at nginx, as for the rest of the
app.

## Preview WebSocket upgrades

The preview routes (`/preview/<port>/...`, `/preview/share/<token>/<port>/...`)
are Next.js route handlers, so they can forward HTTP but cannot accept a
WebSocket upgrade — a Vite HMR or live-reload socket inside a previewed app
would never connect through them. The upgrade half lives on the same
in-process proxy server as the desktop stream (`lib/desktop-proxy/proxy.ts`,
which already owns an `upgrade` event and the session-cookie gate):

- nginx routes preview traffic by the `Upgrade` header: `deploy/nginx.conf`
  maps `$http_upgrade` to a backend (`websocket` → 127.0.0.1:3778, anything
  else → 127.0.0.1:3777) and the `location /preview/` block proxies to it.
  Plain HTTP keeps going to Next.js; only an actual upgrade handshake
  reaches the proxy. The same `location /preview/` block is in the 443
  template.
- The proxy accepts upgrades under the same mounts the HTTP routes serve
  and applies the same gates: the session mount requires a valid session
  cookie for the VM owner (plus the host/origin checks); the share mount
  requires a live token whose bound port equals the port in the path. The
  dial target comes only from `resolvePreviewTarget` — the port must be in
  that owner's detected listening set right now — so an unlisted port is a
  404, never a dial, and the session cookie is never forwarded upstream.
  The tunnel itself is `handlePreviewUpgrade` (`lib/preview/proxy.ts`).
- The socket client must connect under the preview mount
  (`wss://<host>/preview/<port>/...`); a client that connects at the site
  root still hits Next.js and cannot upgrade. Apps that need a sub-path
  base for their assets (Vite `base: './'`) already connect their HMR
  socket under the mount; apps that open an absolute root-path socket do
  not.

## Per-IP rate limiting behind the proxy

Anonymous API calls (sign-in, sign-up, public reads) are rate-limited per
client address, so a brute-force run against `/api/login` only throttles the
address it comes from. The address must come from the reverse proxy, never
from a header the client controls:

```nginx
# /etc/nginx/sites-available/swarmagents.conf
location / {
    proxy_pass http://127.0.0.1:3777;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    # Strip whatever the client sent and re-set it from the peer address.
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

A ready-to-copy reference lives in `apps/swarmagents/deploy/nginx.conf`. If a CDN
sits in front of nginx, forward the address the CDN verified (e.g. Cloudflare's
`CF-Connecting-IP`) instead of `$remote_addr`, and count that hop in
`SWARM_TRUSTED_PROXY_HOPS`.

The container env must match the proxy topology:

| Env | Value | Why |
| --- | --- | --- |
| `SWARM_TRUST_PROXY` | `1` in production | The app may read `X-Forwarded-For` (hop-counted) or `X-Real-IP` to identify the client. Unset, a client-supplied `X-Forwarded-For` is ignored and only the proxy-set address is used. |
| `SWARM_TRUSTED_PROXY_HOPS` | `1` (one nginx hop) | How many trusted proxies sit in front of the app. The client address is the `X-Forwarded-For` entry that many hops from the right, so a client cannot spoof it by prepending entries. |

`deploy/deploy.sh` writes both variables into the production env file
(`.env.v2`) on every deploy. When no client address can be established at all,
the app logs a one-time warning and applies a strict fallback bucket
(`SWARM_RATE_LIMIT_UNIDENTIFIED_PER_MIN`, default 10/min) that is separate from
the app-wide budget.

## TLS / HTTPS

**Where HTTPS terminates:** at the host nginx, in front of the app container.
The app itself serves plain HTTP on 127.0.0.1:3777 (and the desktop proxy on
127.0.0.1:3778); nginx is the only TLS endpoint, and the app's
`X-Forwarded-Proto` handling trusts the `$scheme` nginx sets. There is no
TLS inside the container and no second terminator (no CDN in front as shipped).

**Current state: TLS is not enabled by the repo as shipped.**
`deploy/nginx.conf` listens on port 80 only and serves the app over plain
HTTP. There are no certificates in this repo, and no script here provisions
one — that is deliberate: a private key must never be committed.

**To enable TLS** (operator steps, on the VPS):

1. Obtain a certificate for `swarmagents.codes` (e.g. certbot / Let's Encrypt:
   `certbot --nginx -d swarmagents.codes`, or `certbot certonly` and point
   nginx at the files). Keep the private key root-readable only
   (`/etc/letsencrypt/live/swarmagents.codes/privkey.pem`, mode 600).
2. In `deploy/nginx.conf`, uncomment the 443 server block and replace its
   two placeholder `ssl_certificate` paths with the real certificate and key.
   The block is a complete template (same `location /` and `/desktop/`
   proxies as the port-80 block, plus TLSv1.2+ and HSTS). Do not uncomment it
   with the placeholder paths — nginx will fail to start when the files do
   not exist.
3. Turn the port-80 block into an HTTPS redirect (the commented
   `return 301 https://$host$request_uri;` line in the template) so plain
   HTTP no longer serves the app.
4. Reload nginx (`nginx -t && systemctl reload nginx`) and confirm
   `https://swarmagents.codes/api/health` answers and the HTTP URL redirects.
5. Renewal: certbot's systemd timer renews Let's Encrypt certificates
   automatically; confirm the timer is enabled (`systemctl list-timers
   certbot.timer`) and that renewal reloads nginx (certbot's `--nginx`
   plugin does this; with `certonly`, add a `--deploy-hook "systemctl reload nginx"`).

Until these steps are done, do not call the public endpoint production-ready
over HTTPS — it is HTTP-only.

## Board persistence (swarm-board)

The swarm-board store (tasks, proposals, messages) is a JSON file
(`swarm_board.json`) written atomically (tmp file + rename) into a data
directory resolved at startup from the **first writable candidate**:

| Order | Candidate              | Why                                               |
|-------|------------------------|---------------------------------------------------|
| 1     | `$SWARM_HOME`          | Explicit production override.                     |
| 2     | `/data`                | Canonical volume mount point for containers.      |
| 3     | `os.tmpdir()/swarmagents` | Last-resort fallback — **ephemeral**, state is lost on restart. |

If a candidate exists but is not writable, a loud warning is printed to
stderr and resolution moves to the next candidate. If the final fallback is
used, the board appears to work for the lifetime of the container but every
task vanishes on the next restart.

### Required volume mount

Run the server container with a persistent volume mounted at `/data`
(or set `SWARM_HOME` to a writable path):

```yaml
services:
  swarmagents-dashboard:
    image: swarmagents-v2:latest
    volumes:
      - swarm_data:/data
volumes:
  swarm_data:
```

With that, the board persists to `/data/swarm_board.json`. Do **not** rely on
the container's filesystem: it is not durable and any redeploy/restart wipes
it.

The board's `GET /api/mcp/swarm-board` response now carries a `health` field
so operators can immediately see where the store resolved and whether it is
writable:

```json
{
  "health": {
    "path": "/data",
    "dataFile": "/data/swarm_board.json",
    "writable": true
  }
}
```

If `writable` is `false` or `path` points into a temp directory, fix the
volume mount above.

### Failure semantics

A write failure is never reported as success: persistence errors surface as
JSON-RPC server errors (code `-32603`) with the underlying filesystem message,
so a client that is told "task created" can trust the task is on disk.

## Backup and restore

`/data` is the only copy of the board, users, telemetry, and per-user
provider keys. The scripts in `deploy/` are the in-repo backup:

- `deploy/backup.sh` — tars the contents of `/data` (or `$SWARM_HOME`)
  into a timestamped `swarmagents-backup-YYYYMMDD-HHMMSS.tgz` in the backup
  dir (default `/var/backups/swarmagents`, override with
  `SWARM_BACKUP_DIR`), writes a `.sha256` sidecar, and keeps the newest 7
  backups (`SWARM_BACKUP_KEEP`), deleting older ones. It does not stop the
  app; board writes are atomic, so a live backup is at worst slightly stale.
- `deploy/restore.sh <backup-file.tgz> [--force]` — verifies the archive
  (readable gzip tar, sha256 sidecar when present) and extracts it into
  `/data`. It refuses to overwrite a non-empty data dir without `--force`,
  and refuses to run under a running `swarmagents` container without
  `--force`. Stop the app first, restore, start it again, and check
  `/api/health?ready=1`.

**Rollback never restores `/data`.** `deploy/deploy.sh` rollback restores the
previous image tag plus the newest `.env.v2` and `docker-compose.server.yml`
backups — data is untouched. If `/data` itself is lost or corrupted, only a
`backup.sh` tarball (via `restore.sh`) brings it back.

**Schedule (systemd timer, recommended):**

```ini
# /etc/systemd/system/swarmagents-backup.service
[Unit]
Description=SwarmAgents /data backup
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/backup.sh

# /etc/systemd/system/swarmagents-backup.timer
[Unit]
Description=Daily SwarmAgents /data backup
[Timer]
OnCalendar=daily
Persistent=true
Unit=swarmagents-backup.service
[Install]
WantedBy=timers.target
```

```bash
install -m 755 deploy/backup.sh deploy/restore.sh /usr/local/sbin/
systemctl daemon-reload
systemctl enable --now swarmagents-backup.timer
systemctl list-timers swarmagents-backup.timer
```

Cron equivalent (daily at 03:00, host time):

```cron
0 3 * * * /usr/local/sbin/backup.sh >> /var/log/swarmagents-backup.log 2>&1
```

Backups live on the same host as `/data` unless the operator copies them
elsewhere — a host-disk loss still loses both. Copy the tarballs off-host
(e.g. rsync to the operator's machine) for real disaster recovery, and
test a restore (onto a scratch data dir, `SWARM_DATA_DIR=/tmp/restore-test
deploy/restore.sh <file> --force`) before trusting the schedule.

## Monitoring

There is no built-in alerting. The cheap, dependency-light check is
`deploy/healthcheck.sh`: it polls `GET /api/health?ready=1` (default
`http://127.0.0.1:3777`, override with `SWARM_HEALTH_URL`) with curl only
and exits 0 only on HTTP 2xx with `"ready": true` (board writable, disk OK,
Docker daemon reachable). Anything else exits 1 with the reason on stderr.

**Schedule (systemd timer, every 5 minutes):**

```bash
install -m 755 deploy/healthcheck.sh /usr/local/sbin/healthcheck.sh
install -m 644 deploy/swarmagents-healthcheck.service deploy/swarmagents-healthcheck.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now swarmagents-healthcheck.timer
systemctl list-timers swarmagents-healthcheck.timer
```

Cron equivalent:

```cron
*/5 * * * * /usr/local/sbin/healthcheck.sh >> /var/log/swarmagents-health.log 2>&1
```

**What the timer does not do: page anyone.** A failed check is recorded in
the journal (`journalctl -u swarmagents-healthcheck.service`) and nowhere
else. For alerting, either add an `OnFailure=` notifier unit to
`swarmagents-healthcheck.service`, or point an external uptime monitor at
`https://swarmagents.codes/api/health?ready=1` (the readiness endpoint is
public and safe to poll; it returns booleans and reason codes to anonymous
callers). Also worth watching, and not covered here: disk pressure above
the 256 MB readiness floor, and the container actually being `healthy`
(`docker inspect --format '{{json .State.Health}}' swarmagents`).

## Rebuilding the production deploy from this repo

A fresh VPS can be rebuilt from this repo plus the operator-supplied items
below. `docker-compose.server.yml.example` (in this directory) is the
template of the production compose file — copy it to
`docker-compose.server.yml` and fill in every `<FILL IN>`:

| Must be provided | Where it comes from |
|---|---|
| Host app port (production: 3400, must match `HEALTH_URL` in `deploy/deploy.sh`) | operator choice; see the template |
| `SWARM_SESSION_SECRET` (32+ random bytes) | `openssl rand -hex 32`; lives in `.env.v2` on the VPS only, never in the repo |
| `SWARM_ALLOWED_HOSTS` (public hostname + internal service name) | operator; e.g. `swarmagents.codes,swarmagents` |
| `SWARM_OWNER_EMAIL` | operator |
| `DOCKER_GID` (docker socket group id) | host: `stat -c '%g' /var/run/docker.sock` (Linux) |
| `SWARM_VM_NETWORK` + its subnet (egress rules target it) | operator; `deploy/swarmagents-egress.sh` discovers it from Docker |
| `.env.v2` (session secret, proxy trust, git SHA, any provider env keys) | generated on the VPS by `deploy/deploy.sh`; not in the repo |
| TLS certificate + key for `swarmagents.codes` | operator via certbot; see "TLS / HTTPS" above |
| Git mirror + read-only deploy key (`monolith.git`, `monolith_deploy_key`) | operator; `deploy/deploy.sh` pulls through them |
| Host nginx site config (`deploy/nginx.conf`, TLS block enabled) | copy from this repo, enable TLS per above |
| Egress unit (`swarmagents-egress.{sh,service}`) | in this repo; installed once by the operator (see "Installing the egress unit") |
| `swarm-vm:claude` + `swarm-vm:desktop` VM images | built by `deploy` when missing (or `./deploy.sh build-desktop`); desktop mode is ON by default in the template — opt out per "The per-user desktop VM image" above |
| Backup + healthcheck units (`backup.sh`, `restore.sh`, `healthcheck.sh`, `swarmagents-healthcheck.{service,timer}`) | in this repo; install per "Backup and restore" / "Monitoring" above |

What this repo still does **not** contain (VPS-only by design, reconstruct
from the operator's copies if the VPS disk dies): the TLS private key, the
session secret, the deploy key, the git mirror, and the contents of `/data`
(board/users/telemetry/keys — recoverable only from a `backup.sh` tarball
kept off-host).
