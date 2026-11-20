# `swarm-vm:desktop` — the per-user desktop VM image

The Docker VM driver creates **one container per user** from this image when
desktop mode is on (`SWARM_VM_DESKTOP=1`). Each agent then gets a real Linux
computer it can see and drive: an XFCE desktop on display `:1`, a terminal and
file manager, Chromium, and a browser-viewable VNC web client on the
container's port 6080.

## Build

From `apps/swarmagents`:

```bash
npm run vm-image-desktop:build
# => docker build -t swarm-vm:desktop vm-image-desktop
```

The image builds **on top of `swarm-vm:claude`** (the headless agent image),
so build it first (`npm run vm-image:build`). Then enable desktop mode:

```bash
SWARM_VM_DRIVER=docker
SWARM_VM_DESKTOP=1
# optional: SWARM_VM_DESKTOP_IMAGE=swarm-vm:desktop  (this is the default)
```

## Why this base

We chose to build on our own headless agent image plus Debian packages
instead of pulling a third-party desktop-in-a-container base
(`lscr.io/linuxserver/webtop:debian-xfce`, `kasmweb/core-debian-bookworm`, …):

- **The agent stack is already there** — node 22, the pinned Claude Code CLI,
  git/ripgrep/python3/build-essential/etc. — so the desktop image adds only
  the desktop layer, with one source of truth for the agent tooling.
- **Debian's own archive supplies the desktop** (xfce4, TigerVNC's `Xvnc`,
  noVNC + websockify, chromium, supervisor), which builds cleanly on
  `linux/arm64` and `linux/amd64` and stays lean. `webtop` bundles a full
  browser stack plus its own KasmVNC fork; `kasmweb` images are built for the
  Kasm registry toolchain and carry more platform coupling than we need.
- **noVNC + websockify** (Debian packages) serve the web client on port
  6080 over plain HTTP + WebSocket — exactly the shape the desktop-VM
  contract calls for — and TigerVNC's `Xvnc` is both the X server and the
  VNC server, so there is no separate Xvfb/x11vnc layer to keep in sync.

## Inside the container

| Component | Detail |
|-----------|--------|
| X server / VNC | TigerVNC `Xvnc :1` at 1600x900x24, loopback-only (`-localhost`), password-protected |
| Desktop | XFCE (`xfce4-session`) via `dbus-launch` |
| Web client | noVNC at `http://<container-ip>:6080/` (websockify), proxying `localhost:5901` |
| Terminal / files | `xfce4-terminal`, `thunar` |
| Browser | Chromium (Debian package), desktop shortcut, autostart entry |
| Automation | `xdotool`, `xclip`, `scrot`, `wmctrl`, ImageMagick (`identify`/`convert`) |
| Fonts | Noto, Noto CJK, Noto Color Emoji |
| Supervisor | `supervisord` runs Xvnc, XFCE and websockify; restart-on-failure |

All services run as the unprivileged `node` user (uid 1000). `/workspace`
is owned by that user, as in the headless image.

### The VNC password

The driver generates a random per-container password and copies it into the
created-but-not-yet-started container as a `0600`, node-owned tar entry at
`/home/node/.vnc/.swarm-vnc-password`. This avoids putting the secret in PID
1's environment or argv; the tar stream uses numeric ownership and strips
host-specific xattrs so the same path works on macOS and Linux Docker hosts.
The image's `init.sh` reads that file, writes the obfuscated VNC password file,
and preserves the `0600` plaintext copy so `desktopEndpoint()` can re-read it
after a server restart. A manual `SWARM_VNC_PASSWORD` fallback remains for
standalone `docker run` smoke tests. The password is never sent to the browser
in clear; the web client asks for it over the TLS-less VNC handshake.

No port is ever published to a host port. The web client (6080) is bound to
the container's network interface and is only reachable from inside the
docker network — the driver returns the container IP via
`desktopEndpoint(userId)`.

### Chromium in a container

Chromium ships in Debian with `--no-sandbox` unusable-by-default hardening in
some setups; this container runs it as the unprivileged `node` user with the
standard container-safe flags:

```text
/usr/bin/chromium --no-first-run --no-default-browser-check \
  --disable-features=TranslateUI --start-maximized
```

The driver creates desktop containers with `--shm-size=1g`, so Chromium's
shared-memory needs are covered — **no `--no-sandbox`** is used. If you ever
run the container outside the driver, pass `--shm-size=1g` yourself.

### The agent's desktop tools (computer-use MCP + Playwright MCP)

The image ships the two MCP servers the harness wires into the agent's
Claude Code config in desktop mode:

- `computer-mcp` — the stdio computer-use server (source under
  `/opt/swarm/computer-mcp`, run as `node server.mjs`). It gives the agent
  real control of the on-screen desktop: `screenshot` (PNG of `:1`,
  downscaled to ≤1280 wide), `click`, `double_click`, `move`, `drag`,
  `type`, `key`, `scroll`, `open_app` and `wait`, implemented with
  `xdotool`/`scrot` via argv arrays (never shell strings). Argument
  validation lives in `computer-mcp/validate.mjs`, shared with the harness's
  risk/telemetry layer.
- `playwright-mcp` — the pinned `@playwright/mcp` (0.0.85, installed
  globally as `playwright-mcp`), configured to drive the **same** visible
  Chromium on `DISPLAY=:1` (headed), so the user sees every navigation on
  the desktop.

## Healthcheck

The image declares a `HEALTHCHECK` that probes the noVNC port (6080) — a TCP
connect from inside the container. Because websockify only listens when its
VNC backend is reachable, this covers the whole chain.

## Managed settings

The image inherits the headless image's `/etc/claude-code/managed-settings.json`
(read-only, root-owned): a `PreToolUse` approval hook that blocks every tool
call until the harness returns a synchronous allow/deny, plus a pre-allow list
limited to non-secret read-only tools. See `../vm-image/README.md` for
details.

## Verification notes

The current image was built and booted against a real Docker daemon. The
driver smoke test verified the seeded VNC password (including recovery by a
fresh driver after a container restart), a reachable desktop
endpoint, all desktop/automation binaries (including `vncpasswd` and
ImageMagick), the noVNC HTTP service, launching Chromium through the real
`computer-mcp`, and a non-empty PNG screenshot returned over MCP. A real
Claude Code process also drove the visible browser through `playwright-mcp`,
including a loopback preview and the HTTP 403 private-redirect guard. Test
containers and volumes were removed afterward.

Accepted hadolint-style findings (deliberate):

- **DL3008** (unpinned apt versions): the base image digest pins the set, as
  in the headless image.
- **DL3059** (separate `RUN` layers) is intentionally not split further: the
  single apt layer keeps the desktop toolset one coherent unit.
- **DL3015** (`--no-install-recommends` has no effect here since the system
  packages are explicit): the flag is still kept for consistency and to
  discourage accidental recommendations.

## Smoke test

```bash
# The desktop stack boots and the web client listens (run inside the docker
# network, e.g. from another container on the same bridge):
docker run --rm -d --name smoke-desktop \
  -e SWARM_VNC_PASSWORD=testpass -p 127.0.0.1:6080:6080 \
  swarm-vm:desktop
sleep 15
curl -fsS -o /dev/null http://127.0.0.1:6080/   # noVNC client page
docker exec smoke-desktop sh -lc \
  'command -v chromium xfce4-terminal thunar xdotool xclip scrot wmctrl'
docker rm -f smoke-desktop
```

Use `--shm-size=1g` when running outside the driver.
