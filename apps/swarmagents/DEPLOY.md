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
   `swarm-vm:claude` / `swarm-vm:desktop` images only when `apps/swarmagents/vm-image` /
   `vm-image-desktop` changed.
3. So **a deploy ships whatever is on `main`**. Merge first, then deploy.

What the server script depends on in this repo (do not move or rename without updating the server copy):

| Path in repo | Used for |
| --- | --- |
| `apps/swarmagents/` | rsync source and Docker build context (so the app must stay at this path) |
| `apps/swarmagents/Dockerfile` | the image build |
| `apps/swarmagents/vm-image/`, `apps/swarmagents/vm-image-desktop/` | per-user VM images, rebuilt when changed |

Nothing else in the repo is read by the deploy. The server keeps its working directory under
`/home/ubuntu/infra/apps/swarmagents`; that directory name is a server-side path baked into
`deploy/deploy.sh` and `deploy/deploy-gate.sh`, and is the only remaining reference to that folder name. The server's git mirror, worktree and read-only deploy key also carry a legacy name (`monolith.git`, `monolith-worktree`, `monolith_deploy_key`) for the same reason: they are server-side paths in the installed script, not repo names.

Speed: the deploy is incremental. The Docker context excludes `vendor/`, `tools/`, `docs/`, `branding/`,
`deploy/`, `vm-image/` and `packages/mcp-swarm-board/` (`.dockerignore`), the `npm ci` layer is cached until
`package*.json` changes, and unchanged VM images are skipped.

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
compose time instead of serving an unauthenticated app. Three variables:

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
  so set it in production. If `SWARM_ALLOWED_HOSTS` is set, include the
  internal `swarmagents` hostname as well so VM approval callbacks are
  accepted (see below).

External MCP clients (including the swarm board at
`/api/mcp/swarm-board`) authenticate with `SWARM_HARNESS_TOKEN` as a
`Bearer` token; browser sessions use the signed cookie. Board reads and
writes both require one of the two in server mode — the board is no longer
publicly writable. See `apps/swarmagents/.env.example` for placeholder
values.

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
| Backup + healthcheck units (`backup.sh`, `restore.sh`, `healthcheck.sh`, `swarmagents-healthcheck.{service,timer}`) | in this repo; install per "Backup and restore" / "Monitoring" above |

What this repo still does **not** contain (VPS-only by design, reconstruct
from the operator's copies if the VPS disk dies): the TLS private key, the
session secret, the deploy key, the git mirror, and the contents of `/data`
(board/users/telemetry/keys — recoverable only from a `backup.sh` tarball
kept off-host).
