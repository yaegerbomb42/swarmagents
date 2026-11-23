# SwarmAgents

One chat bar. One agent. Every tool. Nothing hidden.

SwarmAgents is a single-agent, persistent-Linux-VM computer platform driven by
the Claude Code CLI. A user types a prompt; the server starts the agent inside
that user's own long-lived VM container, streams every event (text, tool
calls, results) over SSE, and renders it live in the UI.

This document describes the code on `main` in `apps/swarmagents/`.

## Architecture

```
Browser (Next.js app router, React 19)
  |
  |  POST /api/runtime/tasks, GET /api/runtime/stream/[runId] (SSE)
  v
lib/runtime/manager.ts        per-user run control plane (one active run + FIFO prompt queue)
  |        |
  |        +--> lib/telemetry/bus.ts   sequenced, buffered event bus per run
  |                     |-> /api/runtime/stream/[runId] SSE with resume (Last-Event-ID)
  v
lib/vm/manager.ts             per-user persistent VM (docker or fake driver, quotas)
  v
lib/harness/runner.ts         spawns `claude -p ... --output-format stream-json`,
                              normalizes stream-json into typed TelemetryEvents,
                              redacts secrets from every event
```

Independent subsystems that support the loop:

- **`lib/vm` — persistent VM.** `VmManager` caches one container per user,
  serializes `ensure()` / `reset()` / `exec()` per user, and enforces per-user
  quotas (concurrent execs, exec duration, output bytes — violations throw a
  typed `QuotaError`). It also tracks the last activity per user: after
  `SWARM_VM_IDLE_MIN` minutes without activity the idle sweeper stops the VM
  (the `/workspace` volume survives) and the next `exec()` transparently
  restarts it. A VM with a running exec is never stopped. Drivers:
  `DockerVmDriver` (real containers, `swarm-vm:claude` by default) and
  `FakeVmDriver` (in-process, for tests and local dev without Docker).
  Selected with `SWARM_VM_DRIVER=docker|fake` (default `fake` outside
  production, `docker` in production; simulation must be explicit there).
  Every docker container is created with a hard resource ceiling
  (`--memory`, `--cpus`, `--pids-limit` — `2g` / `2` / `512` by default, see
  `SWARM_VM_MEMORY` / `SWARM_VM_CPUS` / `SWARM_VM_PIDS`) and a hardened
  security profile (`--security-opt no-new-privileges`, `--cap-drop ALL` plus
  the few capabilities a dev box needs). The limits are validated before they
  reach the docker CLI, and re-applied to containers that already exist, so a
  runaway process in one user's VM cannot starve the host. Containers share
  the host kernel; when `SWARM_VM_RUNTIME` is set to an allowlisted runtime
  (e.g. `runsc` for gVisor), it is passed as `docker run --runtime` so the
  VM gets the extra isolation it provides. A runtime that is not registered
  with the daemon fails VM creation with a clear `vm.error` (streamed to the
  run and shown to the user) instead of silently falling back to the default
  runtime. When `SWARM_VM_NETWORK` is set, VM containers are created with
  `docker run --network <name>` so they live on a dedicated network whose
  egress rules cannot affect anything else on the host (unset keeps Docker's
  default bridge). The image the containers are created from is a repo
  artifact: `vm-image/` builds `swarm-vm:claude` (node + git + ripgrep +
  python + the Claude Code CLI and its managed settings) with
  `npm run vm-image:build`.
- **`lib/harness` — Claude Code harness.** `ClaudeCodeRunner` builds the
  `claude` argv (`-p --output-format stream-json --verbose`, plus
  `--resume <sessionId>` when continuing a session, and the prompt as a
  positional argument after `--` so dash-leading prompts are never parsed as
  CLI flags), parses the stream-json
  output into `TelemetryEvent` (`run.started`, `assistant.text`,
  `tool.call`, `tool.result`, `run.finished`, ...), and scrubs env values
  from all emitted text (`redact.ts`). Provider keys are passed via the exec
  env map only — never in argv.
- **`lib/telemetry` — telemetry bus.** `TelemetryBus` keeps a per-run ring
  buffer (default 1000 events) of sequenced events and notifies subscribers.
  `lib/telemetry/sse.ts` powers the SSE endpoint; clients reconnect with a
  `Last-Event-ID` seq and replay anything they missed. `lib/client/useRunStream.ts`
  is the browser-side hook with resume/reconnect.
- **`lib/providers` — provider router.** Server-only multi-provider LLM
  router (`Router`) with Anthropic/OpenAI/Gemini adapters, `SWARM_KEYS_*` key
  pools with rotation and leases, error classification with exponential
  cooldown, sequential failover (default), opt-in racing with `race`
  (simultaneous) or `hedge` (staggered: the primary starts, a second healthy
  provider starts after a hedge delay if no first token has arrived, and the
  loser is aborted; `SWARM_HEDGE_DELAY_MS` tunes the delay, default 1500ms),
  and SSE stream parsing. Keys are never logged (`redact()`); the module
  refuses to run in a browser bundle. `lib/providers/store.ts` persists
  providers and their keys in the providers config file, and
  `lib/providers/keys.ts` masks every key down to its last four characters
  for the API and the UI.
- **`lib/board` — swarm board (internal build coordination).** File-backed store (`swarm_board.json`,
  written atomically) plus `lib/board/handlers.ts` implementing the MCP tools
  served at `POST /api/mcp/swarm-board` (JSON-RPC 2.0) and summarized at
  `GET /api/mcp/swarm-board`. Also `lib/mcp-types.ts` (task/proposal/message
  types and the difficulty→Elo map) and `lib/rate-limit.ts` (token buckets).

Supporting pieces: `lib/auth.ts` (server-mode bearer auth and HMAC session
cookie, `middleware.ts` sets `x-swarm-user`), `lib/roles.ts`,
`lib/verification.ts`, `lib/health.ts` (`/api/health`), and components for
the terminal, browser, telemetry, and role views.

### The agent loop (one run)

1. `POST /api/runtime/tasks` with `{prompt, sessionId?}` — the middleware
   authenticated user starts a run. At most **one run per user**: a new POST
   while one is active queues behind it (`SWARM_MAX_QUEUED`, default 3) and
   starts when the active run finishes; `DELETE ?runId=` cancels the active
   run and its queue (or removes one queued item); `POST {action:"wipe_vm"}`
   resets the VM.
2. `RuntimeManager` ensures the user's VM exists, binds exec to it, and calls
   `ClaudeCodeRunner.run()`. Only an allowlisted env subset
   (`ANTHROPIC_*`, `CLAUDE_CODE_*`, `DISABLE_TELEMETRY`,
   `DISABLE_ERROR_REPORTING`, plus `SWARM_VM_ENV_ALLOW` extras) is forwarded
   into the VM.
3. Harness events are published to the `TelemetryBus`; SSE clients at
   `/api/runtime/stream/[runId]` receive them live and can resume after
   disconnects.
4. When the claude process exits, the run records `sessionId` (for resume),
   cost, duration, and turn count in the per-user run history. Active-run
   state is per-process (lost on restart), but the last session id per user
   persists to `session_store.json` in the storage dir
   (`lib/runtime/session-store.ts`).

### Seeing what the agent wrote (VM file API)

`GET /api/runtime/vm/files` browses the files inside the caller's own VM, so
the user can read what the agent produced.

| Query | Result |
| --- | --- |
| `?path=/workspace/src` | `{kind:"directory", path, parent, entries:[{name, path, type, size, modifiedAt}]}` |
| `?path=/workspace/notes.md&read=1` | `{kind:"file", path, size, binary, truncated, content}` |

- The caller comes from the middleware-set `x-swarm-user` header; the files
  are read from that user's VM only.
- Paths are scoped to `/workspace` (the persistent volume). `..` segments and
  paths outside the workspace are rejected (403) before any driver call
  (`lib/vm/files.ts`).
- Reads are capped at 1 MB (`truncated: true` when the file is bigger) and
  binary files are detected and returned without a text `content` field.

### Managing provider keys

`GET /api/providers` returns the catalog and the configured providers.
`POST /api/providers` saves a provider (and its first key) server-side.

| Request | Effect |
| --- | --- |
| `DELETE /api/providers/[id]` | Removes a saved provider and every key it holds. |
| `PATCH /api/providers/[id]` `{action:"add-key", apiKey}` | Appends a key to the provider. |
| `PATCH /api/providers/[id]` `{action:"remove-key", index}` | Removes the key in that slot. |
| `PATCH /api/providers/[id]` `{action:"rotate-key", index, apiKey}` | Replaces the key in that slot. |
| `PATCH /api/providers` `{id, action, index?, apiKey?}` | The same mutations with the id in the body. |

- Responses never carry key material: a provider is described by its key
  count and one last-4 mask per key slot (`keySlots: [{index, mask}]`).
  Keys are written, encrypted, to the signed-in user's own providers file
  and stay on the server.
- Every route acts on the caller's account only: a user can never list, read,
  mutate, test or route through another user's providers. Only providers the
  user saved can be mutated; a built-in provider they never saved is
  reported as `saved: false`.
- The providers page (`/providers`) exposes the same actions: add a key,
  rotate a slot, drop a key, or remove the provider.

### Rate-limit cooldowns survive a restart

When a provider answers `429` (or fails transiently) the router puts that key
on cooldown and rotates to the next one. That cooldown is persisted to
`$SWARM_HOME/provider_cooldowns.json` and restored on startup, so a restart
does not hammer the same rate-limited key again.

- Entries are keyed by a one-way hash of the key: the file never contains key
  material, only a provider id, a hash, the cooldown deadline and the
  backoff counters.
- Writes are atomic (temp file + rename), and entries whose cooldown elapsed
  are pruned on load.
- The server's long-lived router turns this on (`persistCooldowns`); the
  cooldown state is deployment-wide, so short-lived routers leave it off.

### Per-IP rate limiting for anonymous callers

`lib/rate-limit.ts` keys every token bucket by the caller:

- **Authenticated** requests are keyed by the session user (`user:<id>`), so one
  account can never throttle another account.
- **Anonymous** requests (sign-in, sign-up, public reads) are keyed by the
  client address (`ip:<address>`). A brute-force run against `/api/login`
  (5/min) therefore only throttles the address it comes from, and one busy
  client can no longer spend the app-wide 300/min budget.

The client address comes from the proxy, never from the request itself:

| `SWARM_TRUST_PROXY` | Source of the client address |
| --- | --- |
| unset / off | The peer address: `X-Real-IP` (set by our nginx from `$remote_addr`) or `req.ip`. A client-supplied `X-Forwarded-For` is ignored. |
| `1` | `X-Forwarded-For`, taking the entry `SWARM_TRUSTED_PROXY_HOPS` hops from the right (default `1`), falling back to `X-Real-IP`. |

The nginx config in `deploy/nginx.conf` strips any client-supplied `X-Real-IP`
/ `X-Forwarded-For` and re-sets them from `$remote_addr`, so the address cannot
be spoofed. Production sets `SWARM_TRUST_PROXY=1` (see `deploy/deploy.sh`).

If no address can be established at all, the app logs a loud one-time warning
and falls back to a strict bucket (`SWARM_RATE_LIMIT_UNIDENTIFIED_PER_MIN`,
default 10/min) that is separate from the app-wide budget — never a silently
shared global key.

### Approval gate (allow / ask / deny)

Every tool call the agent makes passes through the pure risk classifier in
`lib/harness/risk.ts` **before** it executes. The decision is a tri-state:

| Level | Meaning | Examples |
| --- | --- | --- |
| `allow` | Benign; executes without asking. | read-only inspection, local builds, tests |
| `ask` | Risky but legitimate; pauses for a human decision. | `rm -rf /` or other destructive root deletions, `curl \| sh` / piping a remote download into a shell, downloads from untrusted hosts, `docker`/`podman` and other container commands, force/destructive git operations, reading or writing credential files (`~/.ssh`, `.env`, `.aws`, ...), privilege elevation (`sudo`), disk/partition tools, broad `chmod`/`chown`, system package-manager mutations, service control, firewall changes, `ssh`/`scp`/`rsync` |
| `deny` | Never allowed; no approval can lift it. | printing secret environment variables, system credential files (`/etc/passwd`, `/etc/shadow`, `/etc/sudoers`, ...), referencing secret env vars with a disclosure verb, cloud instance metadata endpoints (`169.254.169.254` and equivalents) |

An `ask`-level decision pauses the run: the runner creates a pending approval
in the in-memory `ApprovalStore` (`lib/harness/approvals.ts`) and the user
decides with `POST /api/runtime/approvals/{id}` (approve or deny) from the
terminal's approval card. If nobody decides before the TTL expires the
approval auto-expires and is treated exactly like a denial — the run halts
with a `run.error` under the harness risk policy. The pending store is
per-process: a server restart drops pending approvals (their runs end with a
policy error rather than hanging forever).

- TTL: `SWARM_APPROVAL_TIMEOUT_SEC` (seconds, default `300`).
  `SWARM_APPROVAL_TIMEOUT_MS` remains supported as a fallback for
  compatibility; if both are set the seconds form wins.
- Deny always wins over ask, ask always wins over allow.
- The risk classifier is side-effect free: it never runs, reads, or resolves
  anything; unit tests cover the policy table.

### Long-term memory (per account)

The agent can remember things between runs: a preference, a note about a
codebase, a recurring task pattern. The memories belong to the **account**, not
to the VM: they are stored in the app's per-user data directory
(`$SWARM_HOME/users/<hash(userId)>/memory.json`, dir mode `700`, file mode
`600`), so a VM reset, a fresh container or a redeploy never loses them — and
one account never sees another account's memories.

Three MCP tools expose the store to the agent:

| Tool | Arguments | What it does |
| --- | --- | --- |
| `memory_write` | `fact`, `tags?` | Stores one short fact. `tags` are free-form (`preference`, `codebase:<repoHash>`, `task-pattern`, …). |
| `memory_search` | `query`, `k?` | Returns the memories most relevant to a query (default 5). |
| `memory_forget` | `id` | Removes one stored memory. |

How the agent reaches them:

- **In the VM** — the run's `--mcp-config` wires the `memory` MCP server
  (`lib/harness/memory-mcp.ts`), which the claude process spawns. The server
  holds no store: it forwards every call to the host over a small file RPC in
  the VM's ephemeral `/tmp`, and the host-side bridge (`lib/memory/bridge.ts`)
  answers it by running the tool against the account's store. The memory itself
  never touches the VM's persisted volume.
- **Over HTTP** — the same three tools are served as MCP (JSON-RPC 2.0) at
  `POST /api/mcp/memory`, for remote MCP clients.

At the start of every run the account's most relevant memories (top 5, capped
at a 1k-token budget) are injected into the agent's system prompt, so a new run
starts already knowing what the agent remembered last time. When a prompt
shares no keyword with any stored fact, the newest facts are injected instead.

**Secrets are never stored.** A fact is scrubbed with the harness' secret
scanner (`lib/harness/redact.ts`) before it is written — in the VM as well, so
a key the agent was told does not even leave the container.

Embeddings are best-effort and never block a run: the account's own
OpenAI-compatible provider is used first, then a local MiniLM model
(transformers.js) when that optional package is installed, and otherwise the
search falls back to lexical BM25 scoring.

The **Settings → Memory** tab lists the account's memories, searches them,
forgets one, and clears them all.

### Idle hibernation of persistent VMs

A persistent per-user VM holds CPU, memory, and a container slot even when
nobody talks to it, so it is hibernated when it goes idle:

- `SWARM_VM_IDLE_MIN` — minutes of inactivity before the VM is stopped
  (default `30`; `0` disables hibernation entirely).
- `SWARM_VM_SWEEP_INTERVAL_SEC` — how often the idle sweeper checks for idle
  VMs (default `60`). The sweep cadence never exceeds the idle window, so an
  idle VM is hibernated within one idle window at the latest.

A VM with a running exec is never stopped. The `/workspace` volume survives
hibernation: the next `exec()` transparently re-ensures the container and the
user keeps their files. The policy lives in `lib/vm/idle.ts`
(`resolveIdlePolicy`) and the timer in `lib/vm/idle-sweeper.ts` (wired by the
VM manager).

### Provider catalog and key storage

`lib/providers/catalog.ts` holds `PROVIDER_CATALOG`: one typed entry per
well-known provider (Anthropic, OpenAI, Gemini, and other OpenAI-compatible
services) with its wire style (`apiStyle`: `openai-compatible` / `anthropic` /
`gemini` / `custom`), a one-line description, and links to the official
console/key-management pages. It is pure data — safe to import from client
components — and feeds both the providers UI and server-side validation of
saved providers.

Where keys live:

- `SWARM_KEYS_ANTHROPIC`, `SWARM_KEYS_OPENAI`, `SWARM_KEYS_GEMINI` and other
  `SWARM_KEYS_<PROVIDER>` env pools (comma-separated) feed the built-in
  router directly; values never appear in argv and never in logs.
- Providers saved through the UI/API are **per account**:
  `<data dir>/users/<sha256(userId)[:32]>/providers.json` (dir mode 700,
  file mode 600; data dir resolves `SWARM_HOME` → `~/.swarmagents` → `/data`
  → tmp). Keys are sealed with AES-256-GCM, bound to the owner and provider
  id, under a key derived (HKDF-SHA256) from `SWARM_KEYS_SECRET` — or, with a
  warning, from `SWARM_SESSION_SECRET`, or (local dev only) a generated
  `<data dir>/.provider-keys.secret`. Each user's router cooldowns live next
  to it (`provider_cooldowns.json`).
- **Server mode never shares host keys**: `SWARM_KEYS_*` and host
  `ANTHROPIC_*` credentials are not used for any account. Local
  (single-user) mode keeps using them for the machine's own user.
- The legacy server-wide `providers.json` (or `SWARM_PROVIDERS_FILE`) is only
  read once, at startup, to move its entries into the owner's account
  (`SWARM_OWNER_EMAIL`, default `james@swarmagents.codes`), after which it is
  renamed to `providers.json.migrated`. The move waits until that account
  exists. `npx tsx scripts/migrate-providers.ts [--owner email]` does the same
  by hand.
- API responses never carry key material: a provider is described by its key
  count and one last-4 mask per slot (`keySlots: [{index, mask}]`). Keys are
  only ever masked down to their last four characters (`lib/providers/keys.ts`).
- A provider that only gets its keys from `SWARM_KEYS_*` is reported as
  `saved: false` and cannot be mutated through the key-management endpoints.

`GET /api/providers` returns the catalog and the configured providers;
`POST /api/providers` (plus the DELETE/PATCH `remove-key`/`rotate-key`/
`add-key` actions) manages saved providers and keys server-side.

### Local sign-in (login / signup)

SwarmAgents ships with a small local password auth layer (`lib/auth.ts` +
`lib/users.ts`) used when no external identity provider is configured.

- Sessions are HMAC-signed cookies (`SESSION_COOKIE`), `HttpOnly`,
  `SameSite=Lax`, and `Secure` by default. Set `SWARM_COOKIE_SECURE=0`
  (or `false`) to also accept plain HTTP in local development; never disable
  it on an HTTPS origin.
- `SWARM_SESSION_SECRET` is the HMAC key for the session cookie — required;
  the server refuses to mint sessions without it.
- `SWARM_SESSION_MAX_AGE_SEC` — max session lifetime in seconds (default
  `604800`, 7 days).
- `POST /api/signup` creates a local password user. It is **closed by
  default**; set `SWARM_ALLOW_SIGNUP=1` (with `SWARM_SESSION_SECRET`
  configured) to enable self-signup.
- `POST /api/login` verifies the password and signs a session cookie.
  Unknown email and wrong password return the same `401`. The endpoint is
  rate-limited (5 requests/minute) and validates a same-origin `next` param
  (never an open redirect — see `lib/safe-next.ts`).
- `GET /api/me` returns the current session user (or `null`); it never trusts
  a client-supplied user header.
- In **server mode** (`SWARM_SERVER_MODE=1`), `middleware.ts` gates every
  non-public route behind the session cookie (or the server-mode bearer
  `SWARM_HARNESS_TOKEN`) and sets the internal `x-swarm-user` header that
  route handlers trust. `SWARM_ALLOWED_HOSTS` controls the middleware host
  allowlist. In server mode an **unset** allowlist denies every `Host`
  header (the loopback `/api/health` probe is the only exception), so it
  must be set to your public hostname(s) — e.g. in `docker-compose.yml` —
  before the app can serve.

### /api/health fields

`GET /api/health` is a public liveness/readiness probe (exempted from the
rate limiter, `cache-control: no-store`). It is also reachable over loopback
regardless of `SWARM_ALLOWED_HOSTS`, because the container healthcheck probes
`http://127.0.0.1:<PORT>/api/health`; see `DEPLOY.md`. The response body is
safe to expose publicly — counts, booleans, and version strings only, never
keys or paths:

| Field | Meaning |
| --- | --- |
| `ok` | `true` when the swarm board storage directory is writable. |
| `version` | Version from `package.json`. |
| `commit` | Commit SHA this build was cut from (`SWARM_GIT_SHA`), or `unknown` when unset. |
| `builtAt` | Build timestamp (`SWARM_BUILD_TIME`), or `null` when unset. |
| `uptimeSec` | Process uptime in seconds. |
| `board.writable` | Same as `ok`, nested for board-specific checks. |
| `vmDriver` | `SWARM_VM_DRIVER` in effect, or the environment default (`fake` outside production, `docker` in production). |
| `providersConfigured` | How many of the provider keys this build consumes are present (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) — presence only, never values. |

## Environment variables

Never commit real keys. All provider keys live in env only.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SWARM_HOME` | `~/.swarmagents` → `/data` → tmp | Data dir for the swarm board JSON (first writable wins; see `DEPLOY.md`). |
| `SWARM_BOARD_CLAIM_TTL_MS` | `7200000` (2 hours) | Time from claim or review rejection until unsubmitted work returns to the open pool. Positive integer milliseconds; restart all app workers with the same setting. |
| `SWARM_COOLDOWN_FILE` | `$SWARM_HOME/provider_cooldowns.json` | Where the per-key rate-limit cooldown state is persisted. |
| `SWARM_VM_DRIVER` | `fake` outside production, `docker` in production | `docker` for real per-user containers, `fake` in-process. Production never silently simulates work. |
| `SWARM_VM_IMAGE` | `swarm-vm:claude` | Docker image for VMs. Build the managed agent image with `npm run vm-image:build`, or deliberately override it. |
| `SWARM_VM_RUNTIME` | unset | Docker runtime for VM containers (`docker run --runtime`). Only allowlisted runtimes are accepted (`runsc` for gVisor); an invalid value throws a `VmRuntimeError` and a runtime the daemon does not have fails the VM with a clear `vm.error`. |
| `SWARM_VM_NETWORK` | unset | Docker network VM containers join (`docker run --network`). Unset keeps the previous behavior (Docker's default bridge); set it to a dedicated network (e.g. `swarm-vms`) so egress filtering only affects VM containers. The `host` network is rejected — it would give every VM the host's network namespace. |
| `SWARM_VM_MEMORY` | `2g` | Per-VM memory limit (`docker --memory`). Invalid values fail the driver with a `VmLimitError`. |
| `SWARM_VM_CPUS` | `2` | Per-VM CPU limit in cores (`docker --cpus`). |
| `SWARM_VM_PIDS` | `512` | Per-VM PIDs limit (`docker --pids-limit`). `SWARM_VM_PIDS_LIMIT` is accepted as a legacy alias. |
| `SWARM_VM_MAX_CONCURRENT_EXECS` | built-in default | Per-user concurrent exec cap (QuotaError beyond). |
| `SWARM_VM_MAX_EXEC_MS` | `300000` (5 min) | Short terminal-exec duration cap. |
| `SWARM_VM_MAX_OUTPUT_BYTES` | `1048576` (1 MiB) | Short terminal-exec combined stdout+stderr cap (truncated with a marker). |
| `SWARM_VM_AGENT_MAX_EXEC_MS` | `7200000` (2 h) | Duration cap for one complete Claude Code invocation. Set `0` to disable only this duration cap. |
| `SWARM_VM_AGENT_MAX_OUTPUT_BYTES` | `67108864` (64 MiB) | Combined stdout+stderr cap for one Claude Code invocation, including the final stream-json result. Truncation before the final result fails the run with an explicit error. Set `0` to disable only this output cap. |
| `SWARM_VM_APPROVAL_BASE_URL` | LLM proxy origin | VM-reachable origin for the synchronous PreToolUse approval hook. Required for local real Docker runs (the LLM origin is used as a fallback). |
| `SWARM_VM_LLM_BASE_URL` | public origin in server mode | VM-reachable origin for the server-side LLM proxy; also the approval-origin fallback. |
| `SWARM_VM_DISK_QUOTA_MB` | unset (`0`) | Per-user /workspace disk quota in MB; new runs are refused with `run.error` while over it (0 = disabled). |
| `SWARM_VM_IDLE_MIN` | `30` | Minutes of inactivity before a persistent VM is stopped (0 = never stop). |
| `SWARM_VM_SWEEP_INTERVAL_SEC` | `60` | How often the idle sweeper checks for idle VMs. |
| `SWARM_VM_ENV_ALLOW` | unset | Comma-separated extra env var names forwarded into VMs. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI binary inside the VM. |
| `SWARM_APPROVAL_TIMEOUT_SEC` | `300` | Seconds before an unanswered ask-level approval auto-denies and halts the run. |
| `SWARM_MEMORY_MINILM` | unset | Set to `1` to allow the local MiniLM embedder for memories (needs the optional `@huggingface/transformers` package; without a provider embedding the store falls back to BM25). |
| `SWARM_EMBEDDING_URL` | unset | Full embeddings endpoint used for memories (e.g. `https://api.openai.com/v1/embeddings`). Overrides the provider list. |
| `SWARM_EMBEDDING_MODEL` | provider default | Embedding model requested from the embeddings endpoint. |
| `SWARM_EMBEDDING_API_KEY` | unset | Bearer key for `SWARM_EMBEDDING_URL` (read from env only, never logged). |
| `ANTHROPIC_API_KEY` | unset | Provider key forwarded to the VM for Claude Code. |
| `SWARM_KEYS_ANTHROPIC` / `SWARM_KEYS_OPENAI` / `SWARM_KEYS_GEMINI` | unset | Comma-separated key pools for the provider router. |
| `SWARM_HEDGE_DELAY_MS` | `1500` | Hedge delay in ms before a second healthy provider starts when hedged racing is enabled and no first token has arrived. |
| `SWARM_SERVER_MODE` | unset | When set, enable server-mode auth. |
| `SWARM_HARNESS_TOKEN` | unset | Bearer token for server-mode auth (read from env only, never logged). |
| `SWARM_SESSION_SECRET` | unset | HMAC key for the session cookie. |
| `SWARM_ALLOW_SIGNUP` | unset | Set to `1` to allow self-signup at `/api/signup` in server mode (closed by default, in every environment). |
| `SWARM_TRUST_PROXY` | unset | Trust proxy headers for anonymous rate limiting (uses `X-Forwarded-For` with hop counting or `X-Real-IP`). When off, client-supplied `X-Forwarded-For` is ignored and peer identity comes from `X-Real-IP`/peer address. |
| `SWARM_TRUSTED_PROXY_HOPS` | `1` | When `SWARM_TRUST_PROXY` is on, number of trusted proxy hops to count from the right of `X-Forwarded-For` to identify the client. |
| `SWARM_RATE_LIMIT_PER_MIN` | `300` | General API token-bucket rate (per user, or per client IP for anonymous calls). |
| `SWARM_BOARD_RATE_LIMIT_PER_MIN` | `1200` | Swarm-board endpoint rate. |
| `SWARM_RATE_LIMIT_UNIDENTIFIED_PER_MIN` | `10` | Strict fallback rate for anonymous requests whose client identity cannot be established (a one-time warning is logged). |
| `SWARM_ALLOWED_HOSTS` | unset | Allowed hostnames for the middleware host check. Required in server mode: an unset list denies every Host (loopback `/api/health` excepted). |
| `BASE_URL` | `http://127.0.0.1:3777` | App under test for the e2e suite. |
| `SWARM_E2E_MODE` | `local` | `local` (full, incl. dispatch) or `prod` (read-only smoke). |
| `SCREENSHOT_DIR` | `/workspace/swarmagents-playtest/<ts>` | E2E screenshots + `summary.json`. |
| `PW_CHROMIUM_PATH` | playwright default | Existing Chromium binary for e2e. |
| `SWARM_SESSION_MAX_AGE_SEC` | `604800` | Max session lifetime in seconds (default 7 days). |
| `SWARM_COOKIE_SECURE` | `1` | Set to `0`/`false` to also send the session cookie over plain HTTP (local dev only). |
| `SWARM_APPROVAL_TIMEOUT_MS` | unset | Legacy fallback for the approval TTL in milliseconds; `SWARM_APPROVAL_TIMEOUT_SEC` takes precedence when both are set. |
| `SWARM_PROVIDERS_FILE` | `providers.json` in the data dir | Legacy server-wide providers file; only read once to migrate it into the owner's account. |
| `SWARM_KEYS_SECRET` | unset | Secret (32+ random bytes) that per-user provider keys are encrypted with (AES-256-GCM, HKDF-derived). Falls back to `SWARM_SESSION_SECRET` with a warning. Keep it stable: losing it makes stored keys unreadable. |
| `SWARM_OWNER_EMAIL` | `james@swarmagents.codes` | Account that receives the legacy server-wide providers on migration. |
| `SWARM_MAX_QUEUED` | `3` | Max prompts queued per user behind the active run (FIFO). |
| `SWARM_GIT_SHA` | `unknown` | Commit SHA reported by `GET /api/health`. |
| `SWARM_BUILD_TIME` | unset | Build timestamp reported by `GET /api/health` (`null` when unset). |
| `SWARM_ADMIN_USERS` | unset (local mode: `local` owner is admin; server mode: nobody) | Comma-separated user ids or account emails allowed to review/unpublish public-library items — the library-moderation trust boundary. Matched case-insensitively; a `local_<email>` session id also matches the bare email. |
| `SWARM_LIBRARY_PUBLISH_PER_HOUR` | `10` | Public-library publishes allowed per account per hour. |
| `SWARM_COMPLETE_RATE_LIMIT_PER_MIN` | `60` | Per-minute token-bucket rate for run-completion calls. |
| `SWARM_PROVIDER_PROBE_RATE_LIMIT_PER_MIN` | `30` | Per-minute token-bucket rate for provider probe calls. |
| `SWARM_SIGNUP_RATE_LIMIT_PER_MIN` | `5` | Per-minute token-bucket rate for signups. |
| `SWARM_BYOC_PORT` | `3779` | Port the BYOC hub listens on. |
| `SWARM_NODE_HOME` | `~/.swarm-node` | State directory for swarm-node (workspaces, credentials). |
| `SWARM_CLOUD_POOL_CAPACITY` | `5` | Live cloud-pool capacity; `0` simulates a full pool. |
| `SWARM_TEST_DRIVE_SWEEP_INTERVAL_SEC` | `3600` | Seconds between sweeps that roll back abandoned library test-drives. |

## Local development

Requires Node 22 (see `.nvmrc` at the repo root; `engines` in
`apps/swarmagents/package.json`).

```bash
npm install
npm run dev            # next dev on http://127.0.0.1:3777
```

Defaults are dev-friendly: `SWARM_VM_DRIVER` defaults to `fake`, so the
"computer" works without Docker. For real VMs set
`SWARM_VM_DRIVER=docker`, use the managed `swarm-vm:claude` image, and ensure
the Docker daemon is reachable.

Local real Docker runs additionally require both
`SWARM_VM_APPROVAL_BASE_URL` (or a VM-reachable `SWARM_VM_LLM_BASE_URL`
fallback) and `SWARM_SESSION_SECRET`. Startup rejects the run with a
configuration error when either is missing; it never disables the managed
approval hook or silently bypasses approvals.

The approval URL must reach the **host app from inside the VM**, so VM
loopback (`127.0.0.1` / `localhost`) is not the host. Docker Desktop on macOS
and Windows normally uses `http://host.docker.internal:3777`; Linux normally
uses the Docker bridge gateway (often `http://172.17.0.1:3777`, but inspect
the actual network with `docker network inspect bridge`, or inspect the custom
network named by `SWARM_VM_NETWORK`). The default `npm run dev` listener is
loopback-only and is not reachable at either address. Configure a listener or
reverse proxy on the VM-reachable host interface and verify the approval route
from a container before starting a run. The middleware trusts these two
operator-configured callback hosts in local mode (other Host values remain
loopback-only). To avoid exposing the local-only UI, a
reverse proxy can forward only `/api/runtime/approvals/hook` to
`http://127.0.0.1:3777` with `Host: 127.0.0.1`. Do not bind the whole local UI
to an untrusted network.

## The agent VM image (`swarm-vm:claude`)

`vm-image/` holds the image the Docker driver creates one container per user
from. It is a repo artifact — the image production runs is no longer
hand-built on the host:

```bash
npm run vm-image:build      # docker build -t swarm-vm:claude vm-image
```

```bash
SWARM_VM_DRIVER=docker
SWARM_VM_IMAGE=swarm-vm:claude
SWARM_VM_NETWORK=swarm-vms   # optional: dedicated network for VM containers
```

When the app itself runs in Docker, use `docker-compose.yml` together with
`docker-compose.docker.yml`: the override mounts the daemon socket only for
real-VM deployments, selects the managed image, creates the shared `swarm-vms`
network, and points approvals at the app over that network. See `DEPLOY.md`
for the exact command and `DOCKER_GID` requirement.

The image is `node:22-bookworm-slim` plus git, ripgrep, python3/pip/venv,
uv/uvx, Chromium and Playwright MCP, build-essential, jq, curl,
ca-certificates, procps, less, unzip and the Claude Code CLI (pinned via the
`CLAUDE_CODE_VERSION` build arg). It ships
`/etc/claude-code/managed-settings.json`, which registers a synchronous
`PreToolUse` approval hook and pre-allows only non-secret read-only tools.
Every tool call blocks on the harness (`lib/harness/risk.ts`): allow runs,
deny is returned to the model, and ask pauses for the user's approval — the
tool does not execute until that verdict arrives. `vm-image/README.md` has
the details.

The driver needs the Docker socket. Mount it **and** add the container's
user to the host's `docker` group, otherwise the socket is not accessible:

```yaml
services:
  swarmagents:
    group_add:
      - "${DOCKER_GID}"     # get -g docker
    volumes:
      - swarm_data:/data
      - /var/run/docker.sock:/var/run/docker.sock
```

The socket grants control over the host daemon — treat it as optional and
leave it out unless `SWARM_VM_DRIVER=docker` is in use. `DEPLOY.md` covers
the network and egress side.

## Running tests

Unit tests (node:test via tsx, isolated in a temp `SWARM_HOME` so runs never
share session/board state):

```bash
npm run test:unit      # lib/**/*.test.ts and app/**/*.test.ts
```

Run the whole gate in one command (typecheck → unit → build → boot the built
app on a free port with `SWARM_VM_DRIVER=fake` and a temp `SWARM_HOME` → local
e2e → shutdown; screenshots default into that temp home unless `SCREENSHOT_DIR`
is set; exits non-zero on the first failure). Requires the Playwright
Chromium install above:

```bash
npm run test:all
```

E2E playtest (`e2e/README.md` has full details; specs use `playwright-core`):

```bash
npx playwright-core install chromium   # once, or set PW_CHROMIUM_PATH
npm run dev                            # in another shell
BASE_URL=http://127.0.0.1:3777 SWARM_E2E_MODE=local \
SCREENSHOT_DIR=/tmp/swarm-e2e npm run test:e2e
```

Specs: `smoke.spec.ts` (page renders, no console errors, board + health JSON),
`views.spec.ts` (terminal / browser / telemetry views with screenshots), and
`dispatch.spec.ts` (local only: submits a prompt and waits for
`started` → `first token` → `done` in the UI). Every test writes a screenshot
and an entry in `SCREENSHOT_DIR/summary.json`. Production smoke mode
(`SWARM_E2E_MODE=prod`) is strictly read-only and skips dispatch.

Typecheck: `npm run typecheck` (app) and `npx tsc -p e2e/tsconfig.json`.

## How a worker joins the swarm board

The swarm board is an internal build-coordination tool used to develop
SwarmAgents itself — it is not a user-facing product feature. It is a
Remote-MCP-style JSON-RPC 2.0 endpoint at `/api/mcp/swarm-board` (public;
rate-limited separately). Workers can use any MCP/JSON-RPC client.

1. **Initialize** — `POST` `{"jsonrpc":"2.0","id":1,"method":"initialize"}`
   to handshake; `ping` and `tools/list` also work.
2. **Poll** — `tools/call` `poll_tasks` with `{workerElo}` (and optional
   `status` filter) to get open tasks with an Elo alignment score. Difficulty
   thresholds come from `DIFFICULTY_ELO_MAP`: trivial 1000, easy 1200,
   medium 1400, hard 1600, expert 1800.
3. **Claim** — `tools/call` `claim_task` with `{taskId, agentName,
   workerElo}`. Only open tasks can be claimed. Unsubmitted claims expire
   after two hours by default; expired tasks appear open in polls and can
   be reclaimed. Use distinct `agentName` values for concurrent workers;
   the name, not a lease token, identifies the current owner.
4. **Do the work** on a git branch (the task lives in this repo's board; keep
   secrets out of commits).
5. **Submit** — `tools/call` `submit_task_work` with `{taskId, agentName,
   gitBranch, summary, prUrl?}`. `agentName` is required and must exactly match
   the `claimedBy` recorded by `claim_task`; submission is rejected (no
   mutation) for any other agent and unless the task has an active claim or
   is `in_review`. Identical retries while in review do not add history or
   rewrite the board; the owner can still submit revisions. Persistence is
   atomic; a write failure surfaces as a JSON-RPC `-32603` error, never as a
   false success.
6. **Review** — the orchestrator calls `review_and_merge_task`
   (`{taskId, approved, feedback, reviewer?, autoMergeGit?}`). Only tasks in
   `in_review` can be reviewed. Approval sets `completed` on the board; this
   endpoint does not execute or verify a Git merge. Rejection renews the
   claim for the same owner (or returns the task to `open` without an owner).
   The decision records `reviewedBy`, `reviewedAt`, and a transition history
   entry. `poll_tasks` and `GET /api/mcp/swarm-board` expose each task's
   `history` (`from`, `to`, `actor`, `at`), including creation for new tasks.
   Review waiting time doesn't consume the claim. Polls show expiries as of
   their deadline; the next successful claim saves the expiry and the new
   assignment together. There is no background sweeper or heartbeat.

When the backlog is empty, workers can `submit_proposal`
(`{proposedBy, title, problem, proposedSolution, suggestedDifficulty}`) and
the orchestrator `judge_proposal`s them (`{proposalId, approved, feedback?,
finalDifficulty?, actor?}`); approved proposals become tasks. A proposal can
only be judged while `pending`: re-judging an approved or rejected proposal
returns a JSON-RPC error and mutates nothing. Each judgement is appended to the
proposal's `decisions` log (`{approved, feedback, actor, at}`), which
`list_proposals` and `GET /api/mcp/swarm-board` expose; `orchestratorFeedback`
mirrors the latest decision for older clients.

For a quick status check without JSON-RPC: `GET /api/mcp/swarm-board` returns
the board name, health (`path`, `dataFile`, `writable`), task counts, and the
latest tasks/proposals/messages.

The app serializes board writes within one process. Do not point multiple
server processes or the standalone local MCP package at the same writable
board file. Malformed board data is archived with its exact bytes before the
app can recover with an empty board. An unreadable file or failed archive
returns a retryable storage error instead of treating the board as empty.
