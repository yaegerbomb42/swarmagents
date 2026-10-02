# Per-user sandbox ("the agent's own computer") on the Oracle free-tier VPS — deploy lane design

Host: Ampere A1, 4 OCPU (aarch64), 23 GB RAM; ~6 GB used by other services (NPM, aria, swarmconnect, litellm...).

## Phase 1 (built, ships with the full tree): per-user uid inside the app container
- Server runs as root in its container with only SETUID/SETGID/CHOWN/FOWNER/DAC_OVERRIDE/KILL
  (docker-compose.sandbox.yml); every tool process runs as the user's own uid via /usr/local/bin/swarm-run
  (setpriv: no caps, no_new_privs; prlimit: cpu/as/nproc/fsize/nofile). Chromium via /usr/local/bin/chromium-as.
- Isolation: other users' workspaces, auth.db, app state with keys, and the admin secret are unreadable (tested).
- Limits: per-process rlimits + RLIMIT_NPROC per uid; the whole app container is capped at 4 GB / 2 CPU / 512 pids.
  Not possible here: per-user CPU/memory cgroup caps (needs per-user cgroups) -> phase 2.

## Phase 2: one container per active user, started by a host broker
- **swarm-sandboxd** (host systemd service, root): the only thing that talks to Docker. The app container gets
  its unix socket (/run/swarm-sandboxd.sock, mounted), never docker.sock.
- API (JSON over the socket; userId = ^[A-Za-z0-9_-]{1,64}$, everything else fixed server-side):
  - `POST /v1/sandboxes/{user}/ensure` -> `{state: "running", endpoint}` or `{state: "queued", position}`
  - `POST /v1/sandboxes/{user}/exec {argv, cwd, env, timeoutMs}` -> streamed stdout/stderr + exit code
  - `GET  /v1/sandboxes/{user}` -> state, cpu/mem usage, idle seconds, disk used/quota
  - `DELETE /v1/sandboxes/{user}` -> stop (workspace kept)
  - Browser/live viewer: the sandbox runs Chromium with CDP on its internal IP; `endpoint.cdp` is reachable only
    from the app container on the internal network.
- Each user container: image `swarmagents-sandbox` (zsh, python3, node, git, Chromium, fonts), runs as a non-root
  uid, cap_drop ALL, no-new-privileges, read-only rootfs + tmpfs /tmp, only `/workspace` mounted
  (= /data/users/<id>/workspace), network `swarmagents-sandbox` covered by the same egress firewall (no IMDS,
  tailnet, private ranges, host ports).
- Resources (fit the free tier): parent cgroup `swarmagents-sandboxes.slice` CPUQuota=200% MemoryMax=8G, so all
  sandboxes together can never take more than 2 CPUs / 8 GB. Per user: 1 CPU, 1.5 GB RAM (+0 swap), 256 pids,
  disk quota 2 GB (admin 5 GB) enforced by the broker (du on write-heavy ops + refusal).
- Admission + queue: at most MAX_ACTIVE = 4 running sandboxes, and only while host MemAvailable > 3 GB.
  Otherwise FIFO queue; position is reported to the UI ("Your computer starts when a slot frees up: #2").
  Idle sandboxes stop after 10 min (workspace persists), freeing a slot. The admin is never queued behind more
  than one slot (reserved slot).
- Persistence/backup: workspaces live in the swarmagents-data volume -> nightly backup (swarmagents-backup.timer).
