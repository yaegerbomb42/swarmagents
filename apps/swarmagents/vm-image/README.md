# `swarm-vm:claude` — the per-user agent VM image

The Docker VM driver creates **one container per user** from this image. It
used to be built by hand on the VPS, which meant the image that production
ran was not reproducible from the repo. This directory makes it a repo
artifact.

## Build

From `apps/swarmagents`:

```bash
npm run vm-image:build
# => docker build -t swarm-vm:claude vm-image
```

Pin a different Claude Code CLI version with a build arg:

```bash
docker build -t swarm-vm:claude \
  --build-arg CLAUDE_CODE_VERSION=2.1.322 \
  vm-image
```

Then point the app at it:

```bash
SWARM_VM_DRIVER=docker
SWARM_VM_IMAGE=swarm-vm:claude
```

The image is only built locally (or on the image builder); the app itself
never builds it. With `SWARM_VM_PULL=1` the driver can pull the tag from a
registry instead.

## What is inside

Base: `node:22-bookworm-slim`.

| Package | Why |
|---------|-----|
| `git` | version control for the agent's workspace |
| `ripgrep` | `Grep` / `Glob` fall back to `rg` when present |
| `python3`, `python3-pip`, `python3-venv` | Python workflows with working virtual environments |
| `uv`, `uvx` (pinned with pip) | Python tools and Library connectors that use `uvx` |
| `build-essential` | compiling native npm modules |
| `chromium`, `playwright-mcp` | the agent's isolated, headless browser and local-app preview |
| `jq`, `curl` | the usual JSON / HTTP CLI tools |
| `ca-certificates` | TLS for `curl` / `npm` |
| `procps` | `ps`, `top` for process inspection |
| `less` | pager for `git` and friends |
| `unzip` | archive handling |

Claude Code CLI: `npm i -g @anthropic-ai/claude-code@<CLAUDE_CODE_VERSION>`
(default `2.1.322`) and Playwright MCP `0.0.85`. Versions are pinned on
purpose — bump the build args / package pin and rebuild instead of tracking
`latest`. Roles with browser access receive a real `browser-mcp` Playwright
server running isolated Chromium inside the VM. It can preview the agent's
own loopback dev servers; other private/link-local destinations remain denied.
A loopback HTTP/CONNECT proxy applies the same policy to every request,
including subresources and redirect hops, not just the initial tool argument;
a per-page guard provides a second layer of defense.

The container runs as the unprivileged `node` user (uid 1000) with
`/workspace` owned by that user. The driver bind-mounts a per-user named
volume at `/workspace` and drives the container through `docker exec`, so the
workspace survives restarts.

> `python3-pip` on Debian 12 is PEP 668 "externally managed": `pip install`
> into the system Python needs `--break-system-packages` or a virtualenv.
> That is a property of the base image, not of this repo — the agent is
> expected to use a venv.

## Managed settings and the synchronous approval gate

`managed-settings.json` is copied to `/etc/claude-code/managed-settings.json`
(read-only, root-owned). It does two things:

1. **Registers a `PreToolUse` hook** (`/usr/local/bin/swarm-approval-hook`,
   from `hooks/pre-tool-use.mjs`) for every tool (`"matcher": "*"`), with
   hooks explicitly enabled (`"disableAllHooks": false`). Claude Code runs the
   hook *before* a tool call and blocks until it exits.
2. **No longer pre-allows risky tools.** The old blanket
   `permissions.allow` covered `Bash`, `Read`, `Edit`, `Write`, `WebFetch`
   and friends; that was the bug: a headless `claude -p` executed a tool
   immediately, and the harness only classified the call afterwards from
   stdout, so `rm -rf /`, `sudo`, `cat /etc/passwd` or `echo $SECRET` ran to
   completion before the approval card appeared. Only genuinely read-only,
   non-secret tools (`Glob`, `Grep`, `TodoWrite`, `WebSearch`) remain in
   `permissions.allow`; the hook covers the rest.

### How the hook works

Before every tool call the CLI runs the hook with the call on stdin. The hook
POSTs it to the app's `/api/runtime/approvals/hook` endpoint and waits:

- the app authenticates with the **per-run token** the harness passes in the
  exec env (`SWARM_APPROVAL_URL`, `SWARM_APPROVAL_TOKEN`,
  `SWARM_APPROVAL_TIMEOUT_MS`),
- it runs the classifier (`lib/harness/risk.ts`); `allow` returns
  immediately, `deny` returns a block decision whose reason the model sees,
- `ask` creates the normal approval card and blocks until the user approves,
  denies, or the 300s TTL expires — timeout is a **deny**,
- the hook maps `allow`/`deny` to Claude Code's `permissionDecision`, so the
  command is not executed until the harness says so.

It **fails closed**: missing env (a manually launched `claude` outside the
harness), a network error, a non-2xx response, malformed input, or a local
timeout all return `deny`. The CLI-level hook timeout is deliberately much
larger than the harness approval TTL, so the harness's deny always wins the
race.

The endpoint must be reachable from inside the VM. It defaults to the LLM
proxy origin (`SWARM_VM_LLM_BASE_URL`, or `SWARM_PUBLIC_ORIGIN` in server
mode); set `SWARM_VM_APPROVAL_BASE_URL` to override. The harness enables the
hook only when such a base URL is configured *and* `SWARM_SESSION_SECRET` is
present (it signs the per-run token). Real Docker startup rejects a run
with a clear configuration error when either is missing rather than silently
using the legacy stdout gate (which cannot undo a managed-hook denial). Docker
Desktop normally reaches the host through `host.docker.internal`; Linux
normally uses the Docker bridge gateway IP. In both cases the app or a reverse
proxy must actually listen on that VM-reachable interface—the VM's own
`127.0.0.1` is not the host. See the root README's local-development section.

### Full-auto (g9)

When a run is started with `fullAuto: true` (or `SWARM_FULL_AUTO=1`), the
hook auto-allows ask-classified calls that stay **inside** the VM (routine
package installs, `sudo` inside the throwaway container, local destructive
cleanup, …). It still denies hard-deny calls (`/etc/shadow`, secret env
disclosure, cloud metadata) and irreversible **external** actions: remote
`git push`/publish, deploys, `ssh`/`scp`/`curl` egress, credential paths, and
disk destruction. Those cannot be undone or leak data, so an unattended run
must not perform them.

> **Rebuild required.** An image built before this change has the read-only
> old managed settings and no hook. Rebuild (`npm run vm-image:build`) and
> restart VMs for the gate to take effect; the app-side endpoint alone cannot
> stop an unpatched CLI from executing tools early.

## Network

By default the driver starts VM containers on Docker's default bridge.
Setting `SWARM_VM_NETWORK` puts every VM container on a dedicated network
instead:

```bash
SWARM_VM_NETWORK=swarm-vms
```

```bash
docker network create \
  --driver bridge \
  --subnet 172.30.0.0/16 \
  swarm-vms
```

The dedicated network is what makes egress filtering enforceable: rules can
target the `swarm-vms` subnet only, so nothing else on the host is affected
by (or can reach) the VM containers. See `DEPLOY.md` for the egress rule
idea.

## Smoke test

```bash
docker run --rm -it swarm-vm:claude \
  sh -lc 'claude --version && git --version && rg --version && python3 --version && uvx --version && playwright-mcp --version && chromium --version'

# Python virtual environments and package installation work as the node user
docker run --rm swarm-vm:claude \
  sh -lc 'python3 -m venv /tmp/venv && /tmp/venv/bin/pip install Flask==3.1.2'

# the managed settings are in place and read-only
docker run --rm swarm-vm:claude \
  cat /etc/claude-code/managed-settings.json

# the approval hook is installed and fail-closed (no run token => deny)
printf '{"tool_name":"Bash","tool_input":{"command":"id"}}' \
  | docker run --rm -i swarm-vm:claude /usr/local/bin/swarm-approval-hook
# => {"hookSpecificOutput":{...,"permissionDecision":"deny",...}}

# the workspace belongs to the unprivileged user
docker run --rm swarm-vm:claude ls -ld /workspace
```

## Verification notes

The current image was built and exercised against a real Docker daemon. The
smoke checks covered the pinned CLIs, a Python virtualenv installing Flask,
workspace persistence across container restart, targeted cancellation with a
concurrent exec, and the fail-closed approval hook. A real Claude Code process
was also run against a local deterministic Anthropic-compatible test server:
an allowed Bash call created a file, a denied call did not execute, real
Write/Edit/Bash tools edited and passed a test, and a real `browser-mcp`
navigation read a loopback preview page. A loopback URL redirecting to a
private address was stopped by the proxy with HTTP 403. The standalone app
also completed a real Docker-backed run through its HTTP API. No live provider
or external credentials were needed for these tests.

Accepted hadolint-style findings (deliberate, not oversights):

- **DL3008** (pin apt package versions): the Debian packages are not pinned
  on purpose. Pinning them would make the build break on every security
  update of the base image; the base image digest is what pins the set.
- **DL3059** (no consecutive `RUN` instructions): the `apt-get` layer and
  the `npm install -g` layer are kept apart so bumping
  `CLAUDE_CODE_VERSION` does not re-run the apt layer.
- **DL4006** (set the SHELL with `-o pipefail`): no shell pipes are used in
  the build.
