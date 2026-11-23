# API reference (skeleton)

The HTTP surface behind the SwarmAgents UI. This page is the map:
authentication model, route groups, and conventions. Per-route request
and response schemas are being filled in incrementally — until a route
has its own section here, its source under `apps/swarmagents/app/api/`
is the reference (each `route.ts` documents its contract in its header
comment).

Base: your deployment origin (hosted: `https://swarmagents.codes`).
All routes are under `/api/`. The app is a Next.js app router service;
routes are `route.ts` files under `apps/swarmagents/app/api/`.

## Authentication model

Two credential kinds, never mixed:

- **Browser sessions** — a signed session cookie (HttpOnly, Secure,
  SameSite=Lax), minted by `POST /api/login` or `POST /api/signup`.
  Middleware validates it and sets the `x-swarm-user` header that routes
  read the caller from. The header is always overwritten by middleware,
  so a client cannot forge it.
- **Harness / MCP clients** — `Authorization: Bearer <SWARM_HARNESS_TOKEN>`
  for external MCP clients, including the swarm board at
  `/api/mcp/swarm-board`.

In server mode (`SWARM_SERVER_MODE=1`) every route requires one of the
two except the public set: `/login`, `/about`, `/status`, `/api/login`,
`/api/signup`, `/api/me`, and `/api/health`. In local (development) mode
there is no login and loopback is trusted — never expose local mode.

Every route acts on the caller's account only. A user can never list,
read, mutate, or route through another user's providers, runs, VMs,
files, or memory. Responses never carry key material: providers are
described by key counts and last-4 masks only.

State-changing routes are same-origin gated in middleware (CSRF), and
request bodies are size-capped while streaming. Anonymous callers are
rate-limited per client address; authenticated callers per account, so
one account can never throttle another.

## Route groups

Route groups as of `main` (110 `route.ts` files). Groups marked
**core** are the ones integrations usually need.

### Accounts and session

| Route | Purpose |
| --- | --- |
| `POST /api/signup` | Create an account, mint a session. Honors the deployment sign-up posture (open / invite / closed) and bot check. |
| `POST /api/login` | Sign in, mint a session. Responses never reveal whether an email exists. |
| `POST /api/logout` | Clear the session cookie. Idempotent; unauthenticated callers still get `200`. |
| `GET /api/me` | Who am I? Reports the session user, or `null` when signed out (used by the login page). |
| `/api/email-verification/*` | Verify an emailed link; resend verification. Unverified accounts cannot start runs in server mode. |
| `/api/password-reset/*` | Request and redeem a password-reset link (SMTP-backed). |
| `GET /api/health` | Liveness/readiness (`?ready=1` for the deploy gate). Public. |
| `GET /api/audit` | The caller's own security audit log, newest first (`limit`, `before` cursor, `action` filter). |

### Runs — core

| Route | Purpose |
| --- | --- |
| `POST /api/runtime/tasks` | Start a run: `{prompt, sessionId?}`. One active run per user; extras queue (`SWARM_MAX_QUEUED`, default 3). `DELETE ?runId=` cancels the run and its queue (or one queued item). `POST {action:"wipe_vm"}` resets the VM. |
| `GET /api/runtime/stream/[runId]` | SSE event stream for a run. Resume with `Last-Event-ID`; missed events replay from the per-run buffer. |
| `POST /api/runtime/approvals/{id}` | Decide a pending `ask` approval (approve / deny). Expired approvals count as denials. |
| `GET /api/runtime/vm/files` | Browse/read files in the caller's VM workspace. Scoped to `/workspace`; reads capped at 1 MB with `truncated` flagged. |
| `/api/runtime/runs`, `/api/runtime/threads` | Run history and conversation threads for the caller. |
| `/api/runtime/cost`, `/api/runtime/usage`, `/api/runtime/budget` | Per-run and per-account cost/usage accounting and budget controls. |
| `/api/runtime/roles`, `/api/runtime/suggestions`, `/api/runtime/questions` | Role selection, starter suggestions, and agent questions to the user. |
| `/api/runtime/handoffs`, `/api/runtime/watchers`, `/api/runtime/codebase`, `/api/runtime/compute`, `/api/runtime/browser`, `/api/runtime/llm`, `/api/runtime/vault` | Advanced runtime surfaces (handoffs, watchers, codebase context, compute placement, browser control, LLM proxy, secret vault). See each route's header comment. |

The run lifecycle, event types (`run.started`, `assistant.text`,
`tool.call`, `tool.result`, `run.finished`, …), and the approval policy
are described in [Concepts](../concepts.md) and in
[apps/swarmagents/README.md](../../apps/swarmagents/README.md).

### Providers — core (BYOK)

| Route | Purpose |
| --- | --- |
| `GET /api/providers` | Provider catalog + the caller's configured providers (key counts and last-4 masks only). |
| `POST /api/providers` | Save a provider and its first key, encrypted, to the caller's account. |
| `PATCH /api/providers/[id]` | `{action:"add-key"\|"remove-key"\|"rotate-key", index?, apiKey?}` — manage key slots. (`PATCH /api/providers` with `id` in the body is equivalent.) |
| `DELETE /api/providers/[id]` | Remove a saved provider and every key it holds. |
| `/api/providers/test`, `/api/providers/health`, `/api/providers/discover`, `/api/providers/complete`, `/api/providers/settings` | Key testing, provider health, model discovery, completions, and per-account provider settings. |

Only providers the caller saved can be mutated; a built-in provider they
never saved reports `saved: false`. Keys are write-only from the API's
perspective — no endpoint returns key material.

### VMs, computers, and BYOC — core

| Route | Purpose |
| --- | --- |
| `POST /api/byoc/pair` | Create a one-time BYOC pairing code. |
| `GET /api/byoc/pair` | List the caller's paired nodes with online state. |
| `DELETE /api/byoc/pair?deviceId=` | Revoke a node (kills its live session). |
| `/api/computers`, `/api/computers/[id]`, `/api/computers/pair`, `/api/computers/node` | Computer inventory, pairing, and node management (the BYOC/computer surface behind Settings). |
| `/api/share/[token]` | Watch-only share links for runs (stream + metadata). Token-gated; no control. |

### Workspace data

| Route | Purpose |
| --- | --- |
| `/api/projects` | Project list/create for the caller (`GET`, `POST {name, repo?, workspacePath?, activeBranch?}`). |
| `/api/agents` | The caller's saved agents (`GET` list, `POST` create from a validated manifest). |
| `/api/memory` | Long-term memory (`GET` list/search with `q`/`tag`/`k`, `POST` store, `DELETE` clear all). |
| `/api/templates` | Starter templates gallery. |
| `/api/library` | Proof-of-run library: published run artifacts. |
| `/api/lenses` | Re-read an agent message through a lens (`eli5`, `executive`, `code-review`, `security`, `architecture`). |
| `/api/gardener` | Workspace gardener automation surface. |
| `/api/hooks` | Webhook/hook endpoints. |

### Team mode

| Route | Purpose |
| --- | --- |
| `POST /api/team` | Start a team run: `{prompt, agentCard?, settings?}` → `{runId}`. |
| `GET /api/team` | `{run, runs}` for the caller. |
| `DELETE /api/team?runId=` | Cancel a team run. |
| `/api/team/[runId]` | Per-run team control and status. |

### MCP endpoints

| Route | Purpose |
| --- | --- |
| `POST /api/mcp/swarm-board` | Swarm board MCP server (JSON-RPC 2.0). Internal build coordination; harness-token auth in server mode. |
| `GET /api/mcp/swarm-board` | Board summary for the caller. |
| `/api/mcp/memory` | Memory MCP surface for agents. |
| `/api/board-agent` | Board-agent chat surface. |

## Conventions

- **Errors** are JSON with a human-readable message; auth failures do
  not distinguish "no such account" from "wrong password", and sign-up
  failures do not distinguish missing, unknown, or spent invite codes.
- **Streaming** endpoints are SSE with sequence numbers; always send
  `Last-Event-ID` on reconnect.
- **Idempotency:** logout, cancel, and revoke are safe to repeat.
- **Pagination:** cursor-style (`before` timestamps) where lists can
  grow; `limit` is capped server-side.
- **Versioning:** the API evolves with `main`. Pin integrations to a
  commit and re-check route header comments on upgrade.

## What's next for this reference

Per-route schemas (request/response bodies, status codes, examples) will
land group by group, starting with runs and providers. Contributions
welcome — see [CONTRIBUTING.md](../../CONTRIBUTING.md).
