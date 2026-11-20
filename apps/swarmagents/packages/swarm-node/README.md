# swarm-node

Run a SwarmAgents agent sandbox on **your own machine** and connect it to the
SwarmAgents server. The node dials *outbound* over an authenticated WebSocket,
so it works from a laptop behind NAT, a home server or a Docker host — no
inbound ports, no port forwarding.

Once paired, the node appears as the `byoc` VM driver: the server sends it the
same run/exec/file/snapshot/desktop commands it sends to the Docker driver, and
the node runs them inside a local container. Commands never leave the machine
and the machine is never reachable from the network — only the outbound tunnel
exists.

```
agent run ──server──▶ ByocVmDriver ──tunnel──▶ swarm-node ──docker──▶ sandbox
                                    ◀──stdout / files / noVNC──
```

## Quick start

1. In the app, open **Settings → Nodes** and create a pairing code.
2. On the machine that will run the sandbox:

   ```sh
   npx swarm-node --pair ABCD-1234
   ```

   The one-time code is exchanged for a per-device token, which is stored at
   `~/.swarm-node/credentials.json` (mode `0600`). After that, just:

   ```sh
   npx swarm-node
   ```

   and it reconnects automatically.

Requirements: Node.js ≥ 18 and, for the default container mode, a working
Docker installation. For a browser desktop the `swarm-vm:desktop` image (built
from `vm-image-desktop`) provides Xvfb + x11vnc + noVNC.

## Modes

### Container mode (default, isolated)

Every command runs inside a container started from `swarm-vm:desktop`
(override with `--image` or `SWARM_NODE_IMAGE`). Each account gets its own
container and workspace volume. The container is started with the usual
isolation flags (no privileged mode, dropped capabilities, a memory/CPU budget)
and the server cannot ask for a different one: the only command that can touch
the host is `hostExec`, and a node started without `--host-mode` rejects it.

### Host mode (opt-in, trusted machine)

```sh
swarm-node --host-mode
```

Start the node with `--host-mode` **yourself** to run commands directly on the
machine, inside a per-account workspace directory. This is a deliberate,
local-only decision — there is no server message, flag or pairing option that
can turn it on remotely. The same instance of the flag also makes the desktop
run on the host via Xvfb + x11vnc + websockify when those tools are installed.

Use host mode only on a machine you are willing to let the agent modify.

## Desktop

When the node reports a desktop, the server opens a noVNC stream and relays it
over the same multiplexed WebSocket. The browser talks to the app's desktop
proxy; the VNC password is injected server-side and never reaches the browser.
The proxy filters input when the session is in view-only mode.

The VNC password is read from `SWARM_NODE_VNC_PASSWORD`, else from
`~/.swarm-node/vnc-password` (created with mode `0600` on first use). It is
never written to logs.

## Options

```
--server <url>     Server websocket (default wss://swarmagents.codes/byoc/ws,
                   or SWARM_NODE_SERVER).
--pair <code>      One-time pairing code from the app (Settings → Nodes).
--token <token>    Use an existing device token instead of pairing.
--name <name>      Name shown in the app (default: the hostname).
--host-mode        Run commands directly on this machine. Off by default.
--image <image>    Container image for the sandbox (default swarm-vm:desktop).
--state <file>     Where the device token is cached
                   (default ~/.swarm-node/credentials.json).
--help             Show this help.
```

Environment variables: `SWARM_NODE_SERVER`, `SWARM_NODE_IMAGE`,
`SWARM_NODE_HOME` (state directory), `SWARM_NODE_VNC_PASSWORD`.

## Security model

- **Outbound only.** The node opens no listening socket for the server; a
  firewall on the machine can drop all inbound traffic.
- **Per-device credentials.** The pairing code is single-use and expires
  quickly. It is exchanged for a 32-byte random token; the server stores only
  its SHA-256 hash and can revoke it at any time. Revoking a device kills its
  live session immediately.
- **The server cannot choose where to run.** Commands always land in the
  node's container. `hostMode` is set by the local operator at startup and is
  reported to the server, never commanded by it.
- **Multi-tenant scoping.** The hub routes a command only to the device paired
  by the calling account, and the desktop channel carries the account id; a
  viewer for one account can never open another account's desktop.
- **Desktop password stays server-side.** The browser receives noVNC frames;
  the password is injected into the RFB handshake by the desktop proxy.

## Reconnects

The node reconnects with exponential backoff. A run that is in flight when the
tunnel drops pauses and resumes on the same node once it is back (bounded by
the server's resume timeout); the node's container and workspace survive the
disconnect.

## Server configuration

The server runs the BYOC hub in-process. To run it separately:

```sh
SWARM_BYOC_PORT=3779 npx tsx lib/byoc/server.ts
```

- `SWARM_BYOC_PORT` — listening port (default `3779`).
- `SWARM_BYOC_HOST` — bind address (default `127.0.0.1`; put a TLS terminator
  in front for production).
- Set `SWARM_BYOC_DISABLED=1` to turn the in-process hub off.

## Development

```sh
npm install
npm run dev     # tsx src/cli.ts
npm test
npm run build   # emits dist/ including the swarm-node bin
```
