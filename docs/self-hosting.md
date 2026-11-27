# Self-hosting SwarmAgents

Run your own SwarmAgents deployment: the same one-agent-per-VM platform,
on infrastructure you control. This guide covers prerequisites, the
environment surface (names only — never put real values in the repo),
and pointers to the full operator references.

> **Read first:** the canonical operator docs live next to the code.
> This page is the map; [apps/swarmagents/DEPLOY.md](../apps/swarmagents/DEPLOY.md)
> is the territory (deploy topology, ports, verification checklist), and
> [docs/deploy/](deploy/README.md) covers production operations.
> [apps/swarmagents/.env.example](../apps/swarmagents/.env.example) holds
> placeholder values for every variable named here.

## What you are deploying

One app container plus per-user VM containers:

- The **app** (Next.js, `apps/swarmagents/`) serves the UI and `/api/*`
  on container port 3777, with two in-process companions: the desktop
  proxy (3778, VM screen/input + preview WebSockets) and the BYOC hub
  (3779, node dial-in). In the canonical topology a host nginx vhost is
  the only public entry; 3778/3779 bind loopback-only on the host. See
  the port table in DEPLOY.md before changing any number — every artifact
  that mentions a port must agree.
- Each user's **VM** is a container built from `apps/swarmagents/vm-image/`
  (headless) or `vm-image-desktop/` (desktop variant), created on demand
  with hard resource ceilings and a hardened profile.
- **State** (users, providers, board, telemetry, run history) persists
  under `SWARM_HOME` (`/data` in the Compose setup).

## Prerequisites

- A Linux host with **Docker** (the app creates VM containers through the
  host Docker socket) — or run with the fake VM driver for a no-Docker
  demo (see below).
- **Node.js 22** for local development without Docker.
- A public hostname + TLS-terminating reverse proxy (nginx config in
  `apps/swarmagents/deploy/nginx.conf`) for anything beyond loopback.
- SMTP credentials if you want password-reset and verification email
  (required before opening sign-ups; see below).
- Users bring their own provider keys (BYOK). The deployment itself
  needs no model keys for signed-in accounts.

## Quick start: local development

```bash
cd apps/swarmagents
npm ci
npm run dev        # http://127.0.0.1:3777
```

Local mode trusts loopback only: no login, fake VM driver by default,
sign-up open. This is for development on your own machine — never expose
local mode to a network.

Quality gates (run before any deploy):

```bash
npm run typecheck && npm run test:unit && npm run lint && npm run build
```

## Quick start: Docker (single host)

```bash
docker build -t swarmagents-v2:latest apps/swarmagents

# Demo mode, no per-user containers:
docker run --rm -e SWARM_VM_DRIVER=fake -p 3777:3777 \
  -v swarm_data:/data swarmagents-v2:latest
```

For a real deployment use the bundled Compose file, which runs in
**server mode** (authenticated) by default and refuses to start without
a session secret:

```bash
export SWARM_SESSION_SECRET="$(openssl rand -hex 32)"
export SWARM_ALLOWED_HOSTS="swarmagents.example.com"   # your public hostname
docker compose -f apps/swarmagents/docker-compose.yml up --build
```

Build the VM image once (and whenever `vm-image/` changes):

```bash
cd apps/swarmagents && npm run vm-image:build
```

## Server mode: the five variables that matter most

Any real deployment runs with `SWARM_SERVER_MODE=1`. Without it there is
no login at all — anyone who can reach the port has full access. In
server mode the app fails closed at boot when required values are
missing, rather than serving a broken or open site:

| Variable | Purpose |
| --- | --- |
| `SWARM_SERVER_MODE=1` | Enables authenticated server mode (signed session cookie or harness bearer token on every route except login/signup/health). |
| `SWARM_SESSION_SECRET` | HMAC key for session cookies, 32+ random bytes. Rotating it signs everyone out. Also the fallback sealing key for provider keys when `SWARM_KEYS_SECRET` is unset. |
| `SWARM_ALLOWED_HOSTS` | Comma-separated public hostnames the host allowlist accepts. Empty in server mode = refuse to boot. Include the internal `swarmagents` hostname so VM callbacks are accepted. |
| `SWARM_COOKIE_SECURE` | Cookies are Secure (HTTPS-only) by default. Leave unset behind TLS. Set `0` **only** on plain-HTTP deployments, or browsers silently drop the cookie and login loops forever. |
| `SWARM_PUBLIC_ORIGIN` | Public origin (e.g. `https://swarmagents.example.com`). Required for real Docker runs: VMs reach the app's LLM proxy and approval endpoint through it. Without it (or the `SWARM_VM_LLM_BASE_URL` / `SWARM_VM_APPROVAL_BASE_URL` overrides), Docker runs are refused at start with the missing names reported. |

External MCP clients (including the swarm board) authenticate with
`SWARM_HARNESS_TOKEN` as a bearer token. Keep it secret, rotate it if it
ever appears in a log or chat, and never commit its value.

## Sign-up posture

Self-signup is **closed by default** in server mode. Choose deliberately —
every account gets its own VM, so open sign-up spends real compute:

- `SWARM_ALLOW_SIGNUP=1` — open sign-up. Configure the abuse controls
  below first.
- `SWARM_SIGNUP_MODE=invite` + `SWARM_INVITE_CODES` — invite-only.
  Codes are single-use, stored only as keyed hashes, and never logged.
  With invite mode on but no codes configured, sign-up fails closed.
- Unset — closed. To create the first operator account on a fresh
  deployment, temporarily set `SWARM_ALLOW_SIGNUP=1`, create the
  account(s), then unset it and recreate the container.

## Email: verification and password reset

Unverified accounts cannot start runs (they can sign in and configure
providers), so **configure SMTP before opening sign-ups** or new users
can never verify. Variables: `SWARM_SMTP_HOST`, `SWARM_SMTP_PORT`,
`SWARM_SMTP_USER`, `SWARM_SMTP_PASS`, `SWARM_SMTP_SECURE`,
`SWARM_MAIL_FROM` (plus `SWARM_SMTP_HELO`, `SWARM_SMTP_TIMEOUT_MS` if
needed). Verification links are single-use, HMAC-stored tokens
(`SWARM_EMAIL_VERIFY_TTL_HOURS`, default 24 h); password-reset links use
`SWARM_PASSWORD_RESET_TTL_MIN`.

Bot check: set `SWARM_TURNSTILE_SECRET` + `SWARM_TURNSTILE_SITE_KEY`
(Cloudflare Turnstile) and the sign-up form requires a valid widget
token, verified server-side. With the secret unset the check is skipped —
acceptable for closed sign-ups, not for open ones.

## VM and runtime tuning (selected)

| Variable | Purpose |
| --- | --- |
| `SWARM_VM_DRIVER` | `docker` (real containers) or `fake` (in-process, tests/demo). Defaults: `fake` outside production, `docker` in production. |
| `SWARM_VM_MEMORY` / `SWARM_VM_CPUS` / `SWARM_VM_PIDS` | Per-VM hard ceilings (defaults `2g` / `2` / `512`), validated before reaching Docker and re-applied to existing containers. |
| `SWARM_VM_IDLE_MIN` | Minutes of inactivity before the idle sweeper stops a VM (workspace volume survives). |
| `SWARM_VM_MAX_AGENT_VMS` | Cap on concurrent per-agent VMs beyond A1's own (default: `SWARM_MAX_CONCURRENT_VMS`, else 4). A1's VM is governed by the global cap and never counts here; a run that would exceed the cap is refused at admission. |
| `SWARM_VM_AGENT_IDLE_MIN` | Minutes of inactivity before the reaper stops an idle per-agent VM (default: `SWARM_VM_IDLE_MIN`, else 30). `0` disables reaping for agent VMs. A1's VM is never reaped by this timer; always-on users are exempt. |
| `SWARM_VM_RUNTIME` | Optional allowlisted container runtime (e.g. `runsc` for gVisor) for extra isolation. An unregistered runtime fails VM creation loudly instead of falling back silently. |
| `SWARM_VM_NETWORK` | Optional dedicated Docker network for VM containers, so egress rules cannot affect the host. |
| `SWARM_MAX_QUEUED` | Prompts queued behind the one active run per user (default 3). |
| `SWARM_APPROVAL_TIMEOUT_SEC` | Seconds an `ask` approval card waits before expiring as a denial (default 300). |
| `SWARM_TRUST_PROXY` | Set `1` behind the canonical nginx vhost so client addresses come from forwarded headers the proxy overwrites (never client-supplied values). |

Full list with placeholders: `apps/swarmagents/.env.example`.

## BYOC: users bring their own machine

Users can pair their own hardware as the agent's computer instead of
using hosted VMs. Pairing uses one-time codes (`POST /api/byoc/pair`);
the node dials into the BYOC hub over WebSocket (`/byoc/ws` through
nginx to loopback 3779) and authenticates with its node token. Revoking
a node kills its live session. Node software lives in
`apps/swarmagents/packages/swarm-node/` — see its README for install and
pairing. No deployment-side keys are involved; pairing is per account.

## Production deploys and rollback

Production (`swarmagents.codes`) deploys from `main` on the VPS: merge
first, then deploy. The deploy runs typecheck + unit tests, builds on
the VPS, health-checks `/api/health?ready=1`, and rolls back
automatically on failure. Triggers: GitHub Actions (manual, `main` only)
or `./deploy.sh <action>` from a shell with the deploy key. Required
repo secrets (names only): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`,
`DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`. Rollback restores the previous
image and env. The full runbook — forced-command gate, nginx routing
table, egress unit, verification checklist — is in
[DEPLOY.md](../apps/swarmagents/DEPLOY.md) and
[docs/deploy/](deploy/README.md).

**Never deploy without the owner's explicit go-ahead**, and never put a
personal provider key into host or server environment for signed-in
accounts — per-user BYOK only.

## Hardening checklist

- [ ] Server mode on, session secret set, allowed hosts set.
- [ ] TLS in front; `SWARM_COOKIE_SECURE` left at its secure default.
- [ ] Sign-up posture chosen on purpose; SMTP + Turnstile configured
      before opening sign-ups.
- [ ] 3778/3779 loopback-only on the host; nginx is the only public entry.
- [ ] VM ceilings sized for your host; idle sweeper tuned.
- [ ] `SWARM_HARNESS_TOKEN` set, secret, and rotated if ever exposed.
- [ ] Backups for `SWARM_HOME` (`SWARM_BACKUP_DIR`, `SWARM_BACKUP_KEEP`).
- [ ] Gates green: typecheck, unit tests, lint, build.

Next: [Concepts](concepts.md) for the model behind the knobs, or the
[API reference](api/README.md) to automate your deployment.
