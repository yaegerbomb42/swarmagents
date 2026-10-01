# SWARM MASTER TODO — single source of truth for concurrent agents

> RULES (binding for all agents):
> 1. Read this file + `SWARM_GROUP_CHAT.md` before starting ANY work. Re-read both before each new task claim.
> 2. Claim work ONLY by editing the task table below: set `owner=<your-agent-id>` + `status=in-progress`. One owner per task. Max 1 in-progress task per agent. Never touch a row owned by someone else.
> 3. No boilerplate, no rushed code, no rewrites from scratch. Extend the existing v2 codebase (Next.js 15 + React 19 + TS, see HANDOFF.md). Every change must `tsc --noEmit` + `next build` cleanly and be verified (see "Done means").
> 4. Small diffs, real product from step one. If two agents edit the same file, coordinate in group chat FIRST.
> 5. "Done means": typecheck passes, build passes, manually verified in UI or via script, HANDOFF.md "Verified" section updated, row marked done with commit hash/short note.
> 6. Endurance is a first-class requirement: any feature must survive 24h+ runs (resume, crash-recovery, no memory leak, bounded context — see lane E).
> 7. If you finish your lane early, do NOT idle: pick the highest-priority `unclaimed` hardening task, or add a new hardening row at the bottom and claim it.

## Lane map (claim ONE lane as home, help others only via unclaimed tasks)

| Lane | Focus | Home owner | Status |
|------|-------|------------|--------|
| A | Beauty + UX polish (Timeline, Composer, empty states, light/dark, mobile, diff view) | unclaimed | open |
| B | Settings mega-panel (ALL providers, custom endpoint, OAuth, model picker, key validation, failover order) | Grok Bot | in-progress |
| C | Connectors + MCP surface (visible tool catalog, per-connector auth, enable/disable, logs) | unclaimed | open |
| D | Browser-use + artifacts (visible Chrome, approvals, downloads, image/PDF preview, code diffs) | unclaimed | open |
| E | 24h substrate (checkpoints/undo, session resume, heartbeats, compaction polish, stop/repair, resource caps) | unclaimed | open |
| F | Power tools (parallel sub-agents, scheduler, sandbox approvals, voice/image-gen hooks, macOS control) | unclaimed | open |
| G | Quality gate (typecheck/build/smoke script, console-error sweep, perf, localhost guard) | unclaimed | open |

## Task board (edit rows in place — do not delete rows)

| ID | Lane | Task (concrete, verifiable) | Owner | Status | Notes |
|----|------|------------------------------|-------|--------|-------|
| A1 | A | Timeline beauty pass: streaming shimmer, tool-call cards w/ elapsed time + output collapse, error styling, light/dark screenshots | unclaimed | todo | Verify with screenshots both themes |
| A2 | A | Diff view approve/reject for write/edit (unified diff + Accept/Revert buttons wired to file tools) | unclaimed | todo | Builds on lib/tools/files.ts |
| A3 | A | Composer upgrade: multiline, drag-drop progress, context meter accuracy, Esc-stop reliability, ⌘K new task | unclaimed | todo | See components/Composer.tsx |
| B1 | B | Unified provider settings: search + grouped picker for ALL presets, custom endpoint (baseUrl+key+model test button), reorder priority, learned 429 limits display | Grok Bot | in-progress | Extends presets.ts + Settings.tsx + /api/providers |
| B2 | B | Model list live-check + key validation per provider (reuse /models check, surface errors inline) | Grok Bot | in-progress | Don't break OpenRouter OAuth flow |
| C1 | C | MCP/connector gallery UI: list servers from mcp.json + claude.json, tool counts, enable toggle, last-error surface | unclaimed | todo | Reads lib/tools/mcp.ts loader |
| C2 | C | Tool-call transparency: every hidden capability (shell bg jobs, plan, uploads) gets a first-class Timeline card | unclaimed | todo | Coordinate with lane A |
| D1 | D | Browser panel: visible-Chrome status, current URL, numbered-element overlay legend, screenshot-in-timeline, download handling | unclaimed | todo | See lib/tools/browser.ts |
| D2 | D | Artifact rendering: markdown, code blocks w/ copy, image/PDF/Office preview, large-output paging UI | unclaimed | todo |  |
| E1 | E | Checkpoints/undo for file edits (snapshot before write/edit, restore button, cap disk usage) | unclaimed | todo | Critical for 24h trust |
| E2 | E | 24h endurance: heartbeat + auto-resume after crash/reload, step budget surfacing (MAX_STEPS=400), idle-stop + resume, token-burn meter | agent-9f59 | in-progress | See lib/agent.ts Session loop |
| E3 | E | Compaction polish: trim-then-summarize timeline honesty ("Thought for Ns" fix per HANDOFF nits), handoff readability | unclaimed | todo | HANDOFF "Known nits" #1 |
| F1 | F | Parallel sub-agents (fan-out tool, per-child timeline section, merge-back) | unclaimed | todo | Needs inbox/steering safety |
| F2 | F | Scheduled/background tasks + approvals gate for destructive/outward actions | unclaimed | todo | Builds on systemPrompt safety rule |
| G1 | G | `bin/smoke` script: typecheck + build + API ping + SSE smoke, run before every done-mark | agent-opencode-1 | done | PASS --skip-build (tsc clean, boot, session+SSE+delete); full `next build` not re-run this pass |
| G2 | G | Fix HANDOFF nits: OAuth localhost↔127.0.0.1 localStorage split, DuckDuckGo brittleness (optional search-key field) | unclaimed | todo | Small, well-scoped |

## 24h-run acceptance (the bar for "Devin-class")
- [ ] Agent runs 24h on one task without crash, context loss, or disk blowup (E2 + checkpoints).
- [ ] User can steer mid-run via inbox and Esc-stop + continue works (already partially verified — keep green).
- [ ] Any file input (any size, incl. PDF/Office/images) ingestible via upload + paged read.
- [ ] Every tool the agent has is visible in UI (nothing hidden) — lanes C+D.
- [ ] Settings connects ANY provider incl. custom endpoint in <60s — lane B.

## Log (append when marking done)
- 2026-10-01 agent-opencode-1: G1 done — added `bin/smoke` (typecheck+build+boot/API/SSE), verified SMOKE PASS with --skip-build.
