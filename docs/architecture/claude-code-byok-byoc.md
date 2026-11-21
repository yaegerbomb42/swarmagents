# Powering Claude Code with any model: BYOK in the VM, BYOC on swarm-node

Status: **proposal** (nothing here is ported yet). Written 2026-11-20 from Jimmy's local setup and the current code.

## 1. What we already have

Claude Code in the user's VM already never sees a provider key:

```
Claude Code (VM)  --Anthropic Messages-->  /api/runtime/llm/<runToken>/v1/messages   (server)
                                           llm-gateway.ts: router + key pools + budgets + failover
                                           anthropic-bridge.ts / wire-shims.ts: Anthropic <-> OpenAI chat / Responses / Ollama / Gemini
                                           --> user's provider (key lives only server-side, in the secret box)
```

* `manager.ts#applyLlmProxyEnv` sets `ANTHROPIC_BASE_URL=<origin>/api/runtime/llm/<runToken>`, `ANTHROPIC_AUTH_TOKEN=<runToken>`, `ANTHROPIC_API_KEY=""`. The run token is a per-run HMAC (`run-token.ts`).
* `lib/providers/anthropic-bridge.ts` does request/response/SSE translation (tools, tool_result, images, stop reasons, usage, count_tokens estimate).
* `lib/router` picks provider/model/key per attempt (free-first, quotas, cooldowns, health, stickiness, budgets).
* `url-safety.ts` blocks custom provider base URLs that are loopback/private on the shared server (SSRF), unless allowlisted via `SWARM_PROVIDER_PRIVATE_HOSTS`.

So **BYOK for any provider with a public HTTPS endpoint is done**. This is the structural equivalent of Jimmy's `claude-merc`.

## 2. How Jimmy's local pieces map

| Local piece | What it does | SwarmAgents equivalent | Gap |
|---|---|---|---|
| `~/System/bin/claude-merc` | `ANTHROPIC_BASE_URL` -> LiteLLM `:4000` (fallback bridge `:4001`), bearer token, `ANTHROPIC_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` = `mercury-3`, health check before launch | `applyLlmProxyEnv` + router failover + `catalog.ts` `inception` preset (`mercury`) and the Anthropic-compatible "gateway" preset | Tier envs not set (see 4.1) |
| `start-litellm-user.sh` + LiteLLM config | One model name, several upstreams (Fireworks, NVIDIA, Cerebras) with `simple-shuffle`, `num_retries: 2`, rpm/tpm caps; Ollama alias | `SwarmRouter` (pooled keys, rpm/tpm windows, 429/402/401 states) | None; the router is a superset. The LiteLLM config is credentials and stays out of the repo |
| `~/.local/bin/adapter.py` | Anthropic -> OpenAI/Ollama bridge, plus a native-Anthropic passthrough that strips unsupported `anthropic-beta` values and rewrites `thinking` for Azure Foundry | `anthropic-bridge.ts`, `wire-shims.ts` | **Beta/thinking sanitising for Anthropic-style upstreams** (4.2) |
| `ollama-claude-fix.mjs` | Rewrites lowercase tool names (`read`, `bash`...) in model output to Claude Code's PascalCase (`Read`, `Bash`...) | nothing | **Tool-name repair** (4.3) |
| `/workspace/tools/claude-*` (box) | Same env recipe for Modal, Mercury, etc.; adds `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1` and sets every tier model var | `ENV_ALLOW` already forwards `ANTHROPIC_*`, `CLAUDE_CODE_*`, `DISABLE_TELEMETRY` | Not set by default (4.1) |

## 3. Where the bridge runs

**Default: on the server (as now).** Reasons: keys never enter a VM or a user's machine; one place for budgets, health, failover, telemetry; the bridge is pure code and already tested.

**BYOC (swarm-node) has two cases:**

1. *Provider reachable from the server* (any public API): the node's container simply points at the same `/api/runtime/llm/<runToken>` URL over HTTPS. No new code. The run token is the only secret on the user's machine, it is per run and revocable.
2. *Provider only reachable from the user's machine* (Ollama / llama-server / LM Studio on `localhost`, a LAN gateway). The server cannot and must not dial it (SSRF rule). Here, and only here, add a **node-side sidecar**:
   * Runs in `swarm-node` (outside the sandbox), listens on a loopback or docker-bridge port the container can reach.
   * Speaks Anthropic Messages to Claude Code, calls the local endpoint directly. It is the TypeScript port of `adapter.py` (reusing `anthropic-bridge.ts` + `wire-shims.ts`, which are pure and can be shared as a workspace package) plus the tool-name repair.
   * No remote keys are needed: the local endpoint's key (if any) stays in the node's `~/.swarm-node/` config (0600), never uploaded.
   * Selected per run by a new ProviderConfig flag, e.g. `via: "node"`, so the router can still rank it with the others and fail over to server-side providers when the node is offline.
   * New protocol message (node -> server on connect): advertise local endpoints (`id`, `apiStyle`, model list, no secrets) so the app can show them in Settings.

## 4. Pieces to port (in order)

1. **Env recipe** (small, no risk). In `applyLlmProxyEnv` also set `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` to the selected model, plus `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_TELEMETRY=1`. Claude Code otherwise sends background (haiku-tier) calls with Anthropic model names; the gateway maps them via `modelForTier`, but being explicit avoids a wrong-tier pick and phone-home traffic.
2. **Anthropic passthrough sanitising** (from `adapter.py`). For `apiStyle: anthropic` upstreams that are not api.anthropic.com: drop `anthropic-beta` values the upstream rejects (`thinking-*`, `interleaved-thinking-*`, `advisor-tool-*`), normalise `thinking` (`enabled` -> `adaptive`/dropped, strip `budget_tokens`) behind a per-provider `quirks` list so Azure Foundry-style gateways work.
3. **Tool-name repair** (from `ollama-claude-fix.mjs`). Do it generically instead of a hardcoded map: in the OpenAI -> Anthropic response translation, if a returned tool name is not in the request's `tools` but matches one case-insensitively, rewrite it. Works for streaming (`content_block_start`) and non-streaming, no content-length concerns, covers MCP tools too.
4. **Node sidecar** (case 2 above): port `adapter.py` request/response/SSE logic onto the shared bridge package, add the `via: "node"` provider type and the capability advert. Include `/health` and the `/api/claude_code*` stubs `adapter.py` answers.
5. **Fallback health check** from `claude-merc`: the equivalent of "if :4000 is down use :4001" is router failover; add a pre-run probe so a run fails fast with a clear message when no provider is healthy.

Not ported: `claude-foundry-shim` / `claude-mercury-shim` (hardcoded keys), the LiteLLM config (credentials), the standalone `:4001` bridge process.

## 5. Key flow, no leaks

* User enters a key in Settings -> encrypted by `secret-box.ts`, stored server-side per user. The UI only ever gets key *ids* (hashes) and labels.
* The VM / node container gets only the run token, in env (never argv). `redact()` plus the harness redactor strip every raw key from logs and telemetry.
* Server dials providers; keys are in memory only for the attempt (`KeyLease`).
* Local-endpoint keys (case 2) never leave the user's machine.
* Rules to keep: no key in `ANTHROPIC_*` env inside a VM; custom base URLs only public https on the server; run tokens expire with the run.

## 6. Open decisions for Jimmy

* Ship the sidecar for Ollama/LM Studio now, or first only case 1 (public providers) plus step 1-3?
* Do we want a hosted default model for users without keys (Jimmy's Mercury/Inception key) behind the same gateway with the per-run budget cap?
