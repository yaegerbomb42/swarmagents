# Director 24/7 — Build Spec (for Muse)

## 1. What it is
A standalone, harness-agnostic app that runs coding agents 24/7 against any project (game, web app, content, library) and keeps pushing real, visible improvement. It never reaches a "final state" unless the user tells it to stop. It does not depend on Omnexx or any existing codebase.

Core idea: individual LLM sessions stop after ~30 min. Director never asks one session to run forever. It is an outer loop that plans big changes, hands short scoped milestones to fresh worker sessions, verifies them, merges, and re-plans. Forever.

The Director acts as an inline human-in-the-loop: it plays the role a lead engineer / product owner would — judging, rejecting filler, steering — and the real user can override it at any time.

## 2. Non-goals
- Not a new coding agent/harness. It drives existing ones (Claude Code, OpenCode, Aider, Codex CLI, Gemini CLI, Omnexx, any CLI).
- No time-based scheduling. Cycles end when phase gates pass, not when a clock runs out.
- No "99 tiny PRs" behaviour. Volume is not progress.

## 3. First-run setup
1. User launches `director` (CLI + local web dashboard).
2. User pastes providers/keys as free text, any format, e.g.:
   ```
   nvidia nvapi-xxx, nvapi-yyy
   groq gsk_... use qwen
   openrouter sk-or-...  deepseek v4 flash
   ollama local
   ```
3. A small local Ollama model (default 3B–7B, e.g. qwen2.5:3b / llama3.2:3b, user-changeable) parses that text into structured provider entries.
4. Director tests every key: lists models from the provider's /models endpoint, sends one short chat completion and one tool-call probe per candidate model, records latency, tool-calling support, context length, errors, rate limits.
5. Results saved to `~/.director/config.yaml` (keys stored in OS keychain or `~/.director/secrets.env` chmod 600; never logged or printed in full — mask as `nvapi-…a1b2`).
6. User picks (or accepts auto-picked) model roles: Director model, Worker model(s), Cheap/grunt model.
7. User registers harnesses: Director auto-detects installed CLIs on PATH; user can add a custom command template.

Re-running `director keys add "<text>"` repeats steps 3–5 for new keys.

## 4. Directives (what the user asks for)
A run is driven by one active directive (queue more). Built-in directive types, each with its own Discover focus and gates:

| Directive | Discover looks for | Done/gate means |
|---|---|---|
| improve | what a user/player would notice is weak, ugly, boring, missing | before/after screenshots or run-through visibly differ; playtest notes improved |
| add-content | content gaps (levels, items, pages, copy, assets) | new content reachable and working in a real run |
| harden | crashes, edge cases, flaky tests, error handling | new failing tests written then passing; no regressions |
| security | vulns, secrets, deps, authz, injection | findings fixed with a regression test each |
| port <lang/framework> | feature inventory of the source | % of features matching in target; parity tests pass |
| custom "<free text>" | Director model derives focus + gates and shows them to the user for approval | as derived |

Directives are plain text; the Director model classifies them and generates the gate checklist.

## 5. The Cycle (phases, software-engineering style)
Repeats forever until the user stops it.

1. **Discover** — Run the project for real (build, launch, headless browser/screenshots, test suite, CLI run). Read the codebase. Write `state-report.md`: where the project stands against the directive, top weaknesses, with evidence (screenshots, logs).
2. **Plan** — Director turns the report into a roadmap of 1–3 **Big Bets** (changes a user would notice). Each Big Bet → ordered **milestones**, each with: goal, files likely touched, definition of done, verification steps. Plan must not repeat anything already in `changelog.md`. User can approve/edit/veto (or auto-approve mode).
3. **Build** — For each milestone, start a FRESH worker session on a fresh branch/worktree with a tight brief (milestone, relevant context, conventions, done-criteria). Workers are short-lived; if one stalls, dies or loops, Director kills it and retries (different model if repeated failure).
4. **Verify** — Gates per milestone: build passes, tests pass, app boots without console errors, directive-specific gate (e.g. visual diff / playtest). Director reviews the diff like a senior reviewer: rejects filler, scope creep, stubbed code. Fail → back to Build with notes (max N retries, then re-plan the milestone).
5. **Integrate** — Merge passing milestone to main (or the target branch) immediately so the next milestone builds on it. No piles of unmerged PRs. Optional: open PR instead of direct merge if user prefers.
6. **Review** — After all milestones of the cycle: compare project now vs. cycle start against the directive. Append to `changelog.md` and `lessons.md` (what worked, what failed, what not to retry). Then go back to Discover.

**Anti-stale rules**
- Every cycle must land ≥1 milestone on main that visibly/measurably changes the project per the directive. If a cycle lands nothing meaningful, the next Plan must pick a bigger, different bet.
- Plan can't pick work already in the changelog.
- Director scores each cycle's impact (1–10) with evidence; a run of low scores forces a re-scope (bigger bet or new area).

## 6. Roles (all just prompts + model assignments)
- **Director** — owns vision, roadmap, accept/reject. Strongest available model. Acts as inline human.
- **Playtester/Inspector** — runs the project, captures screenshots/logs, writes honest critique.
- **Planner** — (can be Director) splits Big Bets into milestones.
- **Workers** — execute milestones via the chosen harness. Can run several in parallel on non-overlapping milestones.
- **Reviewer/Verifier** — runs gates, reads diffs.
- **Integrator** — merges, resolves conflicts, keeps main green.
- **Scribe** — maintains changelog, lessons, state report.
- **Key Manager** — local small Ollama model: parses keys, tests models, rotates keys on rate limits, picks fallback providers.

## 7. User input & steering (live, any time)
- Dashboard chat + CLI: `director say "make the combat feel heavier"` → injected into Director's next decision; Director acknowledges and adjusts the roadmap.
- Commands: `pause`, `resume`, `stop` (the only way it reaches a final state), `skip <milestone>`, `veto <bet>`, `focus <area>`, `directive <new>`, `approve-mode auto|manual`.
- Approval modes: **auto** (Director decides everything), **plan-approval** (user approves roadmap per cycle), **merge-approval** (user approves each merge).
- Notifications: optional push (ntfy topic, webhook, email) on cycle completion, failures, or when Director wants a human call.

## 8. Harness adapters
Interface each adapter implements:
```
start(brief, workdir, model, env) -> session
status(session) -> running|done|stalled|failed
output(session) -> logs, diff
kill(session)
```
Ship adapters: Claude Code (with custom base URL / router for non-Anthropic models), OpenCode, Aider, Codex CLI, Gemini CLI, generic shell template (`{cmd} --prompt-file {brief} --model {model}`). Stall detection: no new output/diff for X tool-steps or process idle → kill + retry.

## 9. Provider layer
- OpenAI-compatible client covering NVIDIA NIM, Groq, OpenRouter, Mistral, DeepSeek, Together, Ollama, plus Anthropic/Gemini native.
- Built-in local router (OpenAI + Anthropic-compatible endpoint) so any harness can use any provider; rotates keys round-robin, backs off on 429, fails over to the next provider. Never stops the loop over quota — it waits/rotates.
- Quota tracker per key/provider; cheap models for grunt work (summaries, parsing), strong models for Director/Workers.

## 10. State on disk (per project): `.director/`
```
config.yaml          directive queue, roles, gates, approval mode
state-report.md      latest Discover output
roadmap.md           current Big Bets + milestones + status
changelog.md         everything landed, per cycle, with impact score
lessons.md           what worked / failed / don't retry
runs/<cycle>/<milestone>/  briefs, logs, diffs, screenshots, verdicts
```
Everything resumable after crash/reboot: Director reloads state and continues mid-cycle.

## 11. Dashboard (superseded by §16 Web App)
- Live view: current directive, cycle #, phase, active workers + their harness/model, tail logs.
- Roadmap board (Big Bets → milestones, status).
- Before/after screenshot gallery per cycle.
- Changelog with impact scores.
- Steering chat with the Director.
- Providers/keys page: masked keys, model test results, quota usage, add-keys text box.

## 12. Tech suggestions
- Language: TypeScript (Node) or Python — single package, `npx director` / `pipx install director`.
- Git worktrees for parallel workers (never copy worktree dirs).
- Playwright for headless run-throughs and screenshots.
- SQLite for run/quota state; markdown files for human-readable state.
- Ollama for the local Key Manager model.

## 13. Safety rails
- Never print or commit full keys.
- Never force-push the main branch; protected branches respected.
- Configurable path allow/deny list; never touches files outside the project.
- Budget caps per provider (optional), kill switch.

## 14. MVP build order (superseded by §20 Muse Build Brief)
1. Config + key ingestion via local Ollama + model testing + masked storage.
2. Provider layer + local router with key rotation.
3. One harness adapter (OpenCode or Claude Code) + stall detection.
4. The Cycle engine (Discover → Plan → Build → Verify → Integrate → Review) with `.director/` state, single worker.
5. CLI steering commands.
6. Directive types + gates (start with improve + harden).
7. Dashboard.
8. Parallel workers, more adapters, notifications.

## 15. Acceptance test
Point Director at a small existing MVP (e.g. a web game) with directive `improve`, auto mode, and let it run unattended. Success = after several cycles, a human sees clearly different, better gameplay/UI in the before/after captures, main stays green, changelog shows distinct non-repeating Big Bets, and it is still running with no human restarts.


---

## 16. Model & provider control over ANY harness

**Principle:** Director never edits a harness's internals. It owns the network path instead. Every harness talks to Director's built-in **Universal Router**, and the router decides which real provider, model and key serve each request.

### 16.1 Universal Router
- One local server exposing every common API dialect:
  - OpenAI Chat Completions + Responses (`/v1/chat/completions`, `/v1/responses`)
  - Anthropic Messages (`/v1/messages`)
  - Gemini (`/v1beta/models/*:generateContent`)
  - Ollama (`/api/chat`, `/api/generate`)
- Translates between dialects both ways, including tool calls, streaming, images and token usage, so a Claude-only harness can run DeepSeek, a Gemini harness can run Qwen, and so on.
- Per-session routing: each worker session gets its own virtual key (`dir-sess-<id>`), so the router knows which harness, worker and milestone made each call. That gives exact per-harness telemetry and per-session model control.
- Model aliasing: the harness asks for whatever name it expects (`claude-sonnet`, `gpt-5`, `gemini-pro`), and the router maps it to the model Director assigned. This silences most "model not recognised" errors.
- Live hot-swap: Director or the user can switch a running session's model or provider between requests, with no restart.
- Key rotation, 429 backoff, provider failover, budget caps, and request/response logging (secrets masked).

### 16.2 Harness adapter = launch recipe + env injection
Each adapter only has to say how to point the harness at the router and how to start, watch and stop it:

| Harness | How Director routes it |
|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=router`, `ANTHROPIC_AUTH_TOKEN=dir-sess-…`, `ANTHROPIC_MODEL=<alias>`; headless `-p` with `--output-format stream-json` |
| OpenCode | generated `opencode.json` provider entry pointing at the router (OpenAI-compatible); `opencode run` |
| Codex CLI | `OPENAI_BASE_URL` / config provider pointing at the router; `codex exec` |
| Aider | `--openai-api-base router --model openai/<alias>` |
| Gemini CLI | Gemini base URL override → router |
| Cline / Roo / Kilo / Continue (VS Code) | OpenAI-compatible or Anthropic provider setting = router URL + virtual key (Director writes their settings JSON or shows a one-click copy) |
| Cursor CLI, Goose, Crush, Amp, others | any "custom base URL / OpenAI-compatible" option → router |
| Omnexx | native adapter (optional, not required) |
| Generic | command template + env vars `{BASE_URL} {API_KEY} {MODEL}` |

How easy it is depends on the harness:
- **Easy:** anything with a custom base URL or OpenAI/Anthropic-compatible setting. That's nearly all of them.
- **Medium:** harnesses with hard-coded model lists. Fixed with aliasing.
- **Hard or impossible:** closed harnesses locked to their own backend with no base URL override. Director can still launch and watch them through the terminal adapter, but it can't swap their model.

### 16.3 Telemetry capture (three sources, merged per session)
1. **Router:** every request: provider, model, key (masked), tokens in/out/cached, cost estimate, latency, time to first token, streaming speed, errors, retries, tool calls requested.
2. **Process:** stdout/stderr stream (parsed for structured JSON events where the harness supports it), CPU/RAM, exit code, idle time.
3. **Workspace:** git worktree diff stats (files and lines changed), commits, test/build results from Verify, screenshots.
- Stall detector combining all three: no tokens + no diff + no output for N steps → stalled.
- Optional OpenTelemetry export (traces/metrics) for people who already use Grafana/Langfuse.

---

## 17. Web App (pages and data; visual design in §19)

**Stack suggestion:** Node/TypeScript backend (Fastify) + SQLite + WebSocket live stream; React + Vite + Tailwind frontend. Runs locally at `http://localhost:4747`, with optional auth to expose it on a VPS. Installable as a PWA so phone check-ins work.

### 17.1 Pages
1. **Mission Control (home)**
   - Projects running, active directive per project, cycle # and current phase (big phase stepper).
   - Global meters: tokens/min, spend today, requests/min, error rate, active workers, quota left per provider.
   - "Needs you" queue: plan approvals, merge approvals, Director questions, repeated failures.
   - Big buttons: Pause all / Resume / Stop project.
2. **Project view**
   - Directive queue (drag to reorder, add new directive in plain text).
   - Phase timeline across cycles (Discover → … → Review) with durations measured in steps, not wall-clock goals.
   - Roadmap board: Big Bets → milestones (planned / building / verifying / merged / failed), each with its done-criteria.
   - Before/after gallery per cycle (screenshots, short recordings, a slider to compare).
   - Changelog with impact score per cycle plus an impact-trend chart (to catch staleness).
   - Lessons and state report viewers.
3. **Harnesses (telemetry wall)**: one card per running session:
   - Harness name/icon, model (live; dropdown to hot-swap), provider, masked key.
   - Status light (thinking / tool call / editing / testing / idle / stalled / failed).
   - Live terminal tail and a streaming feed of the agent's messages.
   - Tokens in/out, cost, latency, time to first token, tokens/sec sparkline, tool-call count by tool, error count.
   - Diff stats + "view diff" button; current milestone + time on it (in steps).
   - Context window usage bar and compaction count (when the harness reports it).
   - Kill / restart / reassign-to-other-harness / "nudge" (inject a message) buttons.
   - Harness comparison table: success rate, avg retries, avg cost per merged milestone, avg verify-pass rate. This shows which harness and model combo actually ships.
4. **Providers & Keys**
   - Big text box: "paste keys any way you like". The local Ollama model parses it, and a review table shows provider / masked key / detected models before saving.
   - Per key: status, models available, last test results (chat ok, tool calls ok, latency, context length), quota/rate-limit usage, spend, enable/disable, "re-test".
   - Model catalog: every reachable model, sortable by tested speed, tool support, context, cost, and benchmark notes the user adds.
   - Role assignment: drag models onto Director / Planner / Worker / Reviewer / Grunt slots, with fallback order.
5. **Router**
   - Live request log (filter by session/harness/provider/status) with masked payload preview.
   - Alias map editor (requested name → real model).
   - Rotation and failover rules, budget caps, rate-limit backoff settings.
6. **Director chat (steering)**
   - Chat with the Director inline. It answers with what it will change, and you can see why it accepted or rejected each milestone (its review notes).
   - Quick chips: "bigger bet", "focus on X", "veto", "harden next", "stop when this cycle ends".
7. **Settings**
   - Approval mode (auto / plan approval / merge approval), merge target and PR-vs-direct-merge, protected branches.
   - Gate config per directive (which checks must pass, screenshot/playtest commands).
   - Notifications (ntfy topic, webhook, email) and which events trigger them.
   - Local Ollama model choice for the key manager, plus project path allow/deny list.
8. **Logs & History**: searchable event log of every phase, decision, merge and failure, plus export.

### 17.2 Live data model (WebSocket events)
`session.started / status / tokens / toolcall / diff / stalled / ended`, `phase.changed`, `milestone.updated`, `verify.result`, `merge.done`, `director.message`, `quota.updated`, `alert`.

### 17.3 Build order update (insert after MVP step 2)
2b. Universal Router with OpenAI + Anthropic dialects, virtual session keys and aliasing (this one piece unlocks every harness).
7. becomes: Web App: Mission Control + Harness telemetry wall + Providers & Keys first; Roadmap, Gallery and Router pages next.

---

## 18. Dead-simple onboarding (main pain point)

### 18.1 One key to start ("bootstrap key")
- First screen asks for ONE thing: paste any single key (OpenRouter suggested, since one key reaches hundreds of models, including free ones). No Ollama install required to start.
- Director tests the key, auto-picks sensible models for every role (Director / Worker / Grunt), and is ready to run in under a minute.
- That first model then acts as the setup assistant: user can paste more keys later ("here are my nvidia and groq keys"), and it parses, tests, adds failover and rebalances roles automatically.
- Zero-key option: if Ollama is already installed locally, Director detects it and offers to start with local models only.

### 18.2 Key parsing: rules first, model only as fallback
- Known key formats are detected by prefix/regex in plain code, which is instant, free and always right: `sk-or-` OpenRouter, `nvapi-` NVIDIA, `gsk_` Groq, `sk-ant-` Anthropic, `AIza` Gemini, `sk-` OpenAI/DeepSeek (disambiguated by test call), `xai-` xAI, Mistral/Together/Fireworks by test call.
- Only unrecognised or messy input goes to an LLM parser: the bootstrap provider's cheapest model by default, or a local 3B–7B Ollama model if the user prefers offline/private.
- Every key is always validated by a real `/models` + chat + tool-call test before saving. The parser only proposes and the test confirms, so a small model's mistakes can't break the config.
- Keys never leave the machine except to their own provider. If parsing uses a cloud model, keys are masked before being sent (the model only sees structure, e.g. `nvapi-****` + surrounding words).

### 18.3 Adding projects (repos, folders, files)
"Add project" accepts any of these, in one box or by drag-and-drop:
- GitHub/GitLab URL (public, or private via a token or `gh` login) → cloned into a managed workspace.
- Local folder path, or a folder dragged into the browser (via the File System Access API, with an upload fallback).
- Zip upload, or loose files dropped in → Director creates a git repo for them.
- Blank project from a one-line idea ("a cozy farming web game") → Director scaffolds the MVP as cycle 0.
After adding, Director auto-detects stack, build/test/run commands and how to screenshot it, shows them for one-click confirm, and suggests a first directive. No config files to write.

### 18.4 Harness setup
- Auto-detects installed harnesses on PATH, with a one-click "use this" per harness.
- If none are installed, Director runs its own minimal built-in worker so it still works out of the box; installing real harnesses is an upgrade, not a requirement.

### 18.5 First-run flow (target: under 2 minutes)
1. Paste one key → tested, roles auto-filled.
2. Add project (URL, folder, or idea) → stack auto-detected.
3. Type a directive ("improve", "harden", or anything) → Start.
Everything else (more keys, harnesses, approval modes, gates) is optional and comes later from the UI.

### 18.6 Built-in worker ("Director Worker"): untethered from Omnexx
- A small, fresh worker written inside Director, with no Omnexx code or dependency. Target: a few hundred lines.
- Tools only: read file, write/patch file, list/search files, run shell command (sandboxed to the worktree), finish.
- One milestone per session: the brief goes in, it works until the done-criteria pass or it hits the step limit, then exits with a diff + summary. Director handles everything else (planning, verification, retries), so the worker can stay dumb and reliable.
- Talks only to the Universal Router, so it can use any model.
- Omnexx is just another optional harness adapter (§16.2). If Omnexx improves later, it can be plugged in and compared on the telemetry wall like any other harness.


---

## 19. UI design: modern, minimalist, beautifully simple

### 19.1 Principles
1. **One thing per screen.** Each page answers one question ("Is it working?", "What changed?", "What's each agent doing?"). Everything else is one click deeper.
2. **Calm by default, loud only when needed.** A healthy run looks quiet and still. Colour and motion appear only for things that need attention (stalls, failures, approvals).
3. **Progressive disclosure.** Beginners see Start/Pause, the current phase and the latest change. Telemetry, router logs and gate config sit behind "Details" expanders or the Advanced toggle.
4. **Show, don't tell.** Prefer the before/after screenshot, the live diff and the phase stepper over paragraphs of logs.
5. **No setup walls.** Every empty state has one obvious next action ("Paste a key", "Add a project", "Type a directive").
6. **Fast.** Every interaction feels instant (optimistic UI), first paint under 1s, live updates without layout jumps.

### 19.2 Visual language
- **Theme:** dark by default (near-black `#0B0B0F` background, `#14141A` surfaces), with a matching light theme. The UI follows the system setting, with a manual toggle.
- **Colour:** neutral greys plus ONE accent (default electric violet `#7C5CFF`, user-changeable). Status colours are used sparingly: green `#3DD68C` ok, amber `#F5B544` waiting/needs you, red `#FF5C6C` failed/stalled, blue `#4EA8FF` running.
- **Type:** Inter (UI) + JetBrains Mono (code, logs, keys). Scale 12/14/16/20/28/40. Generous line height (1.5). Numbers use tabular figures.
- **Space:** 8px grid, generous padding (24–32px on cards), max content width ~1200px, lots of breathing room. No borders where spacing alone separates things; 1px hairlines (`#ffffff14`) otherwise.
- **Shape:** 12px radius cards, 8px radius inputs/buttons, pill-shaped status chips. Soft shadows only on floating elements (menus, modals, toasts).
- **Icons:** one consistent line icon set (Lucide), 1.5px stroke, 16/20px.
- **Motion:** 150–200ms ease-out transitions; subtle pulse on "running" dots; phase stepper animates forward smoothly. Respect `prefers-reduced-motion`.
- **Glass and gradients:** at most one subtle accent gradient (hero/Start button). No visual noise.

### 19.3 Layout
- **Left rail** (collapsible, icons + labels): Home, Projects, Agents, Keys, Settings. Advanced pages (Router, Logs) appear only when Advanced mode is on.
- **Top bar:** project switcher, global status pill ("Running · Cycle 12 · Build"), Pause/Resume, command palette button.
- **Command palette (⌘K / Ctrl-K):** do anything by typing: "add project", "pause", "swap model to minimax", "directive harden", "show last diff".
- **Steering bar:** a single always-visible input at the bottom of every project page: "Tell the Director…". This is the main way users steer.
- **Mobile/PWA:** rail becomes a bottom tab bar; cards stack; the steering bar stays pinned. Phone use is for checking in, approving and steering, not configuring.

### 19.4 Key screens (what they look like)
- **Home:** a big, calm status card per project: name, directive, a large phase stepper (Discover → Plan → Build → Verify → Integrate → Review), latest merged change with its thumbnail, impact trend sparkline. Above it, a "Needs you" strip that only exists when something does.
- **Project:** a three-tab layout, **Now** (phase, active milestones, live agent cards), **Roadmap** (Big Bets as large cards, milestones as a clean checklist with status dots), **History** (cycle timeline with before/after sliders and changelog entries).
- **Agents (telemetry wall):** a grid of minimal cards. Each card's resting state shows harness icon, model name, status dot, current milestone, and a tiny tokens/sec sparkline. Hover or click expands to the full detail: terminal tail, tokens, cost, latency, tool calls, context bar, diff stats, and Kill/Swap/Nudge actions.
- **Keys:** one large paste box at the top ("Paste any API key"). Below, a clean list of providers with masked keys, a green/red test result and quota bar. The model catalog sits behind "Browse models".
- **Onboarding:** a three-step full-screen flow with one input per screen: (1) paste a key, (2) add a project, (3) type a directive. Large type, a progress dots indicator, and a "Start" button that animates into the Home screen.

### 19.5 Components (build a small design system first)
Button (primary/secondary/ghost/danger), Input, Textarea (auto-grow), Select, Toggle, Chip/StatusPill, Card, Tabs, Stepper, Sparkline, ProgressBar, Toast, Modal/Sheet, Tooltip, CommandPalette, CodeBlock/DiffView, TerminalView, BeforeAfterSlider, EmptyState, Skeleton loaders. Each documented with states (default, hover, focus, disabled, loading, error) in a `/design` page inside the app.

### 19.6 Accessibility and polish
WCAG AA contrast, full keyboard navigation with visible focus rings, ARIA labels on icon buttons, screen-reader friendly live regions for status changes, no information conveyed by colour alone (always icon + text), and copy written in plain, friendly language ("Director is planning the next big change").

---

## 20. Muse Build Brief: read this before writing any code

### 20.1 How to work (non-negotiable)
- **Do not rush.** This project is judged on completeness, organisation and polish, not speed. A slow, correct, well-structured build beats a fast MVP every time.
- **Design before code.** For every phase below: first write the design notes (data models, interfaces, file layout, edge cases) into `docs/`, then implement, then test, then review against the checklist. Never skip a step.
- **Organised from day one.** Set up the full folder structure, tooling, linting, formatting, type checking, testing and CI in Phase 0, before any feature code.
- **Every feature is fully finished before moving on.** "Finished" = implemented, typed, error-handled, tested (unit + integration where relevant), wired to the UI, matching §19 design, documented, and manually exercised. No stubs, TODOs, placeholder data, or fake success paths left behind.
- **Work in small, reviewable commits** with clear messages, one concern per commit. Keep main always green.
- **When unsure, write the question and your chosen answer into `docs/decisions.md`** (an architecture decision log), then continue. Don't silently guess.
- **Self-review at the end of each phase:** re-read the spec section, tick every item in that phase's checklist, run the full test suite and the app, and fix gaps before starting the next phase.
- **Never print, log or commit real API keys.** Use masked display everywhere and test fixtures for keys.

### 20.2 Repository layout
```
director/
  apps/
    server/          Fastify + TypeScript: API, WebSocket, cycle engine, router
    web/             React + Vite + Tailwind: the UI (§17, §19)
  packages/
    core/            cycle engine, directives, gates, state store
    router/          Universal Router (dialects, translation, rotation, aliasing)
    providers/       provider clients + key detection + model testing
    harnesses/       adapters (claude-code, opencode, codex, aider, gemini, generic)
    worker/          built-in Director Worker (§18.6)
    telemetry/       event bus, metrics, stall detection
    ui/              design-system components (§19.5)
    shared/          types, schemas (zod), utils
  docs/              spec copies, architecture, decisions.md, per-phase design notes
  e2e/               Playwright end-to-end tests
```
Tooling: pnpm workspaces, TypeScript strict, ESLint + Prettier, Vitest, Playwright, zod for every boundary, SQLite (better-sqlite3 or Drizzle), GitHub Actions CI (lint, typecheck, test, build).

### 20.3 Phases (each ends with its checklist fully ticked)

**Phase 0: Foundation**
- Monorepo, tooling, CI, strict TS, shared types, config loader, logging (with automatic secret masking), error model, SQLite schema + migrations.
- Empty web app shell with the §19 theme, rail, top bar, command palette skeleton, `/design` page.
- ✅ Checklist: `pnpm build/test/lint/typecheck` all pass in CI; secret-masking unit tests; design tokens in one file.

**Phase 1: Design system**
- Build every §19.5 component with all states, light/dark themes and accessibility.
- ✅ Checklist: every component shown on `/design`; keyboard and screen-reader checks; visual snapshot tests.

**Phase 2: Providers and keys**
- Prefix/regex key detection (§18.2), LLM fallback parser, masked storage, `/models` listing, chat + tool-call tests, quota tracking.
- Keys page and onboarding step 1 (§19.4).
- ✅ Checklist: tests per provider format; invalid/expired key handling; rate-limit handling; no key ever appears unmasked in logs, UI or DB dumps.

**Phase 3: Universal Router**
- OpenAI, Anthropic, Gemini and Ollama dialects, translation (tools, streaming, images, usage), virtual session keys, aliasing, rotation, failover, budgets, request log.
- Router page (Advanced).
- ✅ Checklist: contract tests per dialect pair; streaming tests; failover test with a mocked 429; hot-swap test.

**Phase 4: Projects**
- Add project from URL, folder, drag-drop, zip, files or idea (§18.3); stack and command detection; managed workspaces; git worktrees.
- Onboarding step 2.
- ✅ Checklist: each input type tested; detection tested on sample Node, Python and static-site repos; confirm/edit flow works.

**Phase 5: Built-in Director Worker**
- Minimal tool loop (read, patch, search, shell, finish), sandboxed to its worktree, step limits, diff + summary output.
- ✅ Checklist: completes scripted milestones on fixture repos; can't touch files outside its worktree; clean exit on limit.

**Phase 6: Harness adapters**
- Claude Code, OpenCode, Codex, Aider, Gemini CLI, generic template; auto-detection on PATH; env injection to the router; start/status/output/kill.
- ✅ Checklist: each adapter tested (real or mocked binary); stall detection tested; adapters listed in Agents page.

**Phase 7: Telemetry**
- Event bus, WebSocket stream (§17.2), metrics from router/process/workspace, stall detector, OpenTelemetry export.
- Agents page telemetry wall (§19.4).
- ✅ Checklist: live updates with no layout jump; metrics accurate against fixtures; kill/swap/nudge work.

**Phase 8: Cycle engine**
- Discover, Plan, Build, Verify, Integrate, Review (§5); roadmap and milestone state; anti-stale rules; impact scoring; crash-safe resume; `.director/` files.
- Home and Project pages; onboarding step 3 (directive → Start).
- ✅ Checklist: full cycle runs end-to-end on a fixture project; resume after kill mid-phase; rejected filler milestone is re-planned; no repeated Big Bets.

**Phase 9: Directives and gates**
- improve, add-content, harden, security, port, custom; per-directive gates; screenshot/playtest capture with Playwright; before/after slider.
- ✅ Checklist: each directive has tests and a sample run; gates block bad merges.

**Phase 10: Steering and approvals**
- Steering bar, Director chat, quick chips, command palette actions, approval modes, "Needs you" strip, notifications (ntfy, webhook, email).
- ✅ Checklist: steering message changes the next plan; each approval mode tested; notifications fire.

**Phase 11: Polish and hardening**
- Performance pass, empty/error/loading states everywhere, mobile/PWA, accessibility audit, copywriting pass, docs (README with 2-minute quickstart, screenshots, architecture overview).
- ✅ Checklist: Lighthouse 90+; axe audit clean; fresh-machine install to first cycle in under 2 minutes.

**Phase 12: Acceptance**
- Run §15's acceptance test unattended on a sample game. Fix anything it reveals, then repeat until it passes.

### 20.4 Definition of done for the whole project
Every section of this spec implemented, every phase checklist ticked, CI green, no TODOs/stubs, docs complete, and the acceptance test passes with visibly better results after several unattended cycles.
