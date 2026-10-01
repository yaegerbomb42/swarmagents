> SUPERSEDED 2026-10-01 by coordinator ruling: MASTER_TODO.md is the canonical board. This file is a frozen recovery snapshot (reconstructed after a wipe) — do not edit rows here.

# SWARM MASTER TODO — single source of truth for concurrent agents

> RULES (binding for all agents):
> 1. Read this file + `GROUP_CHAT.md` before starting ANY work. Re-read both before each new task claim.
> 2. Claim work ONLY by editing the task table below: set `owner=<your-agent-id>` + `status=in-progress`. One owner per task. Max 1 in-progress task per agent. Never touch a row owned by someone else.
> 3. No boilerplate, no rushed code, no rewrites from scratch. Extend the existing v2 codebase (Next.js 15 + React 19 + TS, see HANDOFF.md). Every change must `tsc --noEmit` + `next build` cleanly and be verified (see "Done means").
> 4. Small diffs, real product from step one. If two agents edit the same file, coordinate in group chat FIRST.
> 5. "Done means": typecheck passes, build passes, manually verified in UI or via script, HANDOFF.md "Verified" section updated, row marked done with commit hash/short note.
> 6. Endurance is a first-class requirement: any feature must survive 24h+ runs (resume, crash-recovery, no memory leak, bounded context — see lane E).
> 7. If you finish your lane early, do NOT idle: pick the highest-priority `unclaimed` hardening task, or add a new hardening row at the bottom and claim it.
> 8. Run `bin/sync-github "<lane/task>: what changed"` after every verified chunk (typecheck green). It refuses on API keys.
> 9. Root agent chowns everything it creates; everyone builds with `NEXT_DIST_DIR=.next-<you>` and tests on scratch ports. Never touch `~/.swarmagents` or `:3777`.

> RECONSTRUCTED 2026-10-01 ~18:15Z by agent-opencode-1 after the file was wiped to 0 bytes. Claims restored
> from GROUP_CHAT.md history. If your claim is wrong here, fix your row and post in chat. Coordinator ruling
> on canonical board still pending — this restore is data recovery, not a governance move.

## Lane map (claim ONE lane as home, help others only via unclaimed tasks)

| Lane | Focus | Home owner | Status |
|------|-------|------------|--------|
| A | Beauty + UX polish (Timeline, Composer, empty states, light/dark, mobile, diff view) | cline-01 (A1 slice) | open |
| B | Settings mega-panel (ALL providers, custom endpoint, OAuth, model picker, key validation, failover order) | Grok Bot | in-progress |
| C | Connectors + MCP surface (visible tool catalog, per-connector auth, enable/disable, logs) | unclaimed | open |
| D | Browser-use + artifacts (visible Chrome, approvals, downloads, image/PDF preview, code diffs) | unclaimed | open |
| E | 24h substrate (checkpoints/undo, session resume, heartbeats, compaction polish, stop/repair, resource caps) | agent-9f59 / cline-01 (E1) | in-progress |
| F | Power tools (parallel sub-agents, scheduler, sandbox approvals, voice/image-gen hooks, macOS control) | atlas-runtime (runtime plane) | in-progress |
| G | Quality gate (typecheck/build/smoke script, console-error sweep, perf, localhost guard) | agent-opencode-1 | open |
| DEPLOY | swarmagents.codes via infra/deploy.sh (Dockerfile, auth gate, compose, nginx, token) | Grok Bot (deploy) | live, redeploying on cadence |

## Task board (edit rows in place — do not delete rows)

| ID | Lane | Task (concrete, verifiable) | Owner | Status | Notes |
|----|------|------------------------------|-------|--------|-------|
| A1 | A | Timeline beauty pass: streaming shimmer, tool-call cards w/ elapsed time + output collapse, error styling, light/dark screenshots | cline-01 | in-progress | Copy-buttons added; screenshots pending |
| A2 | A | Diff view approve/reject for write/edit (unified diff + Accept/Revert buttons wired to file tools) | cline-01 | done | Shipped w/ E1 slice (Timeline LCS diff + Undo) |
| A3 | A | Composer upgrade: multiline, drag-drop progress, context meter accuracy, Esc-stop reliability, ⌘K new task | unclaimed | todo | See components/Composer.tsx |
| B1 | B | Unified provider settings: search + grouped picker for ALL presets, custom endpoint (baseUrl+key+model test button), reorder priority, learned 429 limits display | Grok Bot | done | Sync a369ea96c. lib/connections.ts + /api/connections{,/test,/oauth} + Settings.tsx (catalog: 43 LLM, 23 tool keys, 25 MCP; one form; Test; live models; drag order; toggles). tsc+build green, e2e 16/17 (compaction = agent.ts cut bug, agent-9f59) |
| B2 | B | Model list live-check + key validation per provider (reuse /models check, surface errors inline) | Grok Bot | done | Sync a369ea96c. testProvider(): /models or 1-token ping for no-list providers (Bedrock, Perplexity); friendly errors; key redaction; OpenRouter OAuth kept + proxy-safe redirects (lib/http.ts) |
| C1 | C | MCP/connector gallery UI: list servers from mcp.json + claude.json, tool counts, enable toggle, last-error surface | Grok Bot | done | Sync a369ea96c. 25 presets, stdio/HTTP/SSE, Test lists tools, OAuth sign-in (lib/mcp-oauth.ts), imported Claude servers shown by name + toggle via override, live runtime status/last error per row |
| C2 | C | Tool-call transparency: every hidden capability (shell bg jobs, plan, uploads) gets a first-class Timeline card | unclaimed | todo | Coordinate with lane A |
| D1 | D | Browser panel: visible-Chrome status, current URL, numbered-element overlay legend, screenshot-in-timeline, download handling | unclaimed | todo | COORDINATOR asked about BrowserPane 18:15 |
| D2 | D | Artifact rendering: markdown, code blocks w/ copy, image/PDF/Office preview, large-output paging UI | unclaimed | todo | atlas-runtime artifact store overlaps — coordinate |
| E1 | E | Checkpoints/undo for file edits (snapshot before write/edit, restore button, cap disk usage) | cline-01 | in-progress | Snapshot/restore/diff shipped; disk cap + GC left |
| E2 | E | 24h endurance: heartbeat + auto-resume after crash/reload, step budget surfacing, idle-stop + resume, token-burn meter | agent-9f59 | done | Crash resume + bounded events + stall watchdog verified on Groq |
| E3 | E | Compaction polish: trim-then-summarize timeline honesty ("Thought for Ns" fix per HANDOFF nits), handoff readability | unclaimed | todo | agent.ts is L1-owned — coordinate w/ agent-9f59 |
| F1 | F | Parallel sub-agents (fan-out tool, per-child timeline section, merge-back) | unclaimed | todo | Needs inbox/steering safety |
| F4 | F | Endurance: quota wait must not discard work; run must survive 24h+ on a limited key | atlas-runtime | done | Fix: quota waits recorded (note+step) but run continues in place (1 attempt, no re-run); aborted runs still park. Covered by `npm run test:runtime` #3 + `test:runtime:mock` #2. Unblocked team tsc (lib/tools/shell.ts NODE_ENV) |
| F2 | F | Durable task/run control plane (lib/runtime/*, app/api/runtime/*, Activity UI) | atlas-runtime | done | tsc clean; unit e2e 16/16 + real-agent mock integration PASS; 3 durability bugs fixed; Activity panel wired; DEPLOYED to swarmagents.codes |
| F3 | F | Approvals gate for destructive/outward actions surfaced in Activity (resume/approve actions) | atlas-runtime | in-progress | Budget/quota block now; extending to destructive tool confirmation + resume buttons |
| T1 | G | Deterministic e2e harness: mock LLM (OpenAI+Anthropic) + mock MCP + `npm run test:e2e` (17 cases) | Grok Bot | done | Sync 402fcd9ee (18 cases, 17 pass; compaction = agent.ts). tests/{e2e,mock-llm,mock-mcp}.mjs; `npm run test:e2e [-- --only x,y | --prod | --url]` |
| W1 | L2 | web_search uses Settings tool keys (Brave→Tavily→Exa→Serper), then legacy settings/env Tavily, then DDG; each API failure falls through and the error is reported | Grok Bot | done | Sync 402fcd9ee. lib/tools/web.ts; e2e `search` (brave 401 → tavily 200) via SWARM_SEARCH_MOCK |
| G1 | G | `bin/smoke` script: typecheck + build + API ping + SSE smoke, run before every done-mark | agent-opencode-1 | done | SMOKE PASS; uses .next-smoke isolation |
| G2 | G | Fix HANDOFF nits: OAuth localhost↔127.0.0.1 localStorage split, DuckDuckGo brittleness (optional search-key field) | agent-opencode-1 | done | Sync 07809c3cf; auth matrix verified |
| G3 | G | Auth-gate regression tests (tests/auth-gate.mjs): local/server/misconfigured matrix for lib/auth.ts | agent-opencode-1 | done | 26/26 pass pure-node; sync pending |
| DEPLOY1 | DEPLOY | swarmagents.codes live via infra/deploy.sh v2 branch (Dockerfile, auth gate, compose, nginx, owner token, preflight /login 200 + /api 401) | Grok Bot (deploy) + atlas-runtime | done | Sync caa4ee3e9 + atlas-runtime redeploy 252s (VPS tsc+next green, preflight login=200/api=401/badhost=403); all /api/runtime/* live & gated 401 |

## 24h-run acceptance (the bar for "Devin-class")
- [ ] Agent runs 24h on one task without crash, context loss, or disk blowup (E2 + checkpoints).
- [ ] User can steer mid-run via inbox and Esc-stop + continue works (already partially verified — keep green).
- [ ] Any file input (any size, incl. PDF/Office/images) ingestible via upload + paged read.
- [ ] Every tool the agent has is visible in UI (nothing hidden) — lanes C+D.
- [ ] Settings connects ANY provider incl. custom endpoint in <60s — lane B.

## Log (append when marking done)
- 2026-10-01 agent-opencode-1: G1 done — `bin/smoke` (typecheck+build+boot/API/SSE), SMOKE PASS.
- 2026-10-01 agent-opencode-1: G2 done — canonical origin client-side + Tavily fallback. Sync f196e82b3, then 07809c3cf (docs + middleware loop fix + auth matrix verified).
- 2026-10-01 agent-9f59 (from chat): E2 done — crash resume + no step cap + plan nudge + quota bench + bounded events + stall watchdog, verified on Groq.
- 2026-10-01 cline-01 (from chat): checkpoint/diff slice done (files.ts snapshot/restore, Timeline LCS diff + Undo, /api/checkpoints/restore).
- 2026-10-01 ~18:15 agent-opencode-1: board reconstructed after wipe to 0 bytes; claims restored from GROUP_CHAT.md.
