# Swarm (swarmagents v2) handoff, paused 2026-09-30

## What this is
A from-scratch rebuild of swarmagents. One chat bar talks to one agent that has every tool, and all of its
thinking, tool calls, compactions and notices stream into the main view. Settings only manages LLM providers.
It runs locally on the Mac. Stack: Next.js 15, React 19, TypeScript 6 (7 isn't supported by Next 15).

Run: `./bin/swarm` builds if needed, serves http://127.0.0.1:3777 and opens it. Dev: `npm run dev`.
Data: `~/.swarmagents`, overridable with `SWARM_HOME` (sessions, uploads, settings.json with keys at 0600,
limits.json, browser-profile, mcp.json).

## State: working, built, tested end to end. NOT committed.
- Git: the old app shows as deleted and the new files are untracked. The old version is saved on branch
  `archive/swarmagents-v1`. The monorepo has unrelated uncommitted changes (omnexx, litellm, DEPLOY.md);
  don't sweep them into a commit. Commit only `apps/swarmagents` when asked.
- ~/.swarmagents settings are empty; the user adds keys in Settings.

## Layout
- `lib/types.ts`: shared types (Msg/Block history, AgentEvent UI stream, StreamOp).
- `lib/store.ts`: JSON persistence.
- `lib/presets.ts`: about 30 providers, grouped. Everything except Anthropic uses the OpenAI-compatible adapter.
- `lib/providers/anthropic.ts`: native API with adaptive thinking and caching. On an "invalid signature" 400 it
  retries once with thinking blocks stripped (proxies and gateways invalidate replayed thinking). Base URLs
  are set explicitly so ANTHROPIC_BASE_URL in the shell never leaks in.
- `lib/providers/openai.ts`: OpenAI-compatible adapter (reasoning_content, tool calls, images).
- `lib/router.ts`: providers in priority order with failover. Rate limits are learned from 429s (rpm/tpm at
  the moment of throttle), and requests are paced at 90% of the learned ceiling. Also holds context-window
  guesses and learning.
- `lib/agent.ts`: session runtime (on globalThis), the agent loop, runs read-only tools in parallel, inbox
  steering, stop plus history repair, two-stage visible compaction at 75% (trim old outputs, then a streamed
  summary). Thinking is stripped whenever history is rewritten. Overhead-aware token accounting.
- `lib/tools/`: bash (streams output, persistent cwd, own process group so stop kills the tree, background
  mode), read/write/edit files (paged; PDF and Office via pdftotext/pypdf/textutil), search (ripgrep),
  web_search (DuckDuckGo HTML), web_fetch, browser (playwright-core, visible persistent Chrome, numbered
  elements plus screenshot), plan, mcp (auto-loads ~/.swarmagents/mcp.json, ~/.claude.json, Claude Desktop).
- `app/api/`: providers (CRUD, reorder, /models check, which also validates OpenRouter keys), sessions (SSE
  stream, send, delete, stop), upload (streams raw body to disk, any size, bypasses middleware),
  connect/openrouter (OAuth PKCE one-click; verifiers kept in lib/oauth.ts).
- `middleware.ts`: rejects non-local Host/Origin (the agent has full control of the Mac).
- `components/`: Timeline, Composer (XHR upload progress, paste/drop, Esc stops, context meter), Settings
  (searchable grouped picker, one-click connect, auto model pick), icons.

## Verified
Groq gpt-oss-120b: upload, shell, write, verify. Claude via the session proxy: browser, thinking, caching.
Also verified: stop mid-command then continue, forced compaction with recall, failover, localhost guard,
OpenRouter connect redirect and bad-callback rejection, Ollama model listing (runs locally), light and dark
screenshots.

## Not yet verified
- A direct api.anthropic.com key (only tested through the proxy).
- The full OpenRouter OAuth round trip (needs the user's login).
- Real 429 learning under load (the logic is reviewed, not triggered).
- MCP servers (only `swarmworld` is configured in ~/.claude.json).
- Env keys: OPENROUTER_API_KEY is empty; GEMINI_API_KEY is rejected; GROQ works.

## Known nits
- "Thought for Ns" understates the time (summarized thinking arrives in a burst; timing starts at the first delta).
- The OAuth callback returns to `localhost` (not 127.0.0.1), so localStorage (last open session) differs per host.
- Web search scrapes DuckDuckGo HTML, which is brittle. Consider adding an optional search API key.

## Next up (proposed to the user, awaiting their pick)
1. Checkpoints/undo for file edits  2. Memory across tasks  3. Parallel sub-agents  4. Diff view with approve/reject
Later: full macOS app control, scheduled/background tasks, image generation and voice, sandbox mode, cloud runner.
