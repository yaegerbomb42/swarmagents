# SwarmAgents master todo

## Current pass — owned, outcome-based work

- [x] **Task status at a glance** (UI): show live/idle state, current action, elapsed time and plan progress in the single-task view; avoid showing the same plan twice; keep Composer as the only steering surface.
- [x] **Provider setup works end to end** (Integrations): implement the model discovery/connection check route already called by Settings, with useful failure handling and no key leakage.
- [x] **Safe recovery after a process interruption** (Runtime): repair incomplete tool-call transcripts on load, make uncertain side effects explicit, and persist the recovered checkpoint without replaying operations.
- [x] **Review the combined product slice** (Coordinator): task status, provider setup, and restart recovery fit the existing one-chat flow; repo typecheck/build pass and the live auth-gated shell responds correctly. Remaining product/security/endurance gaps are split into owned TODO rows below; the 24h soak remains unclaimed/unpassed.

## Next, only after the current pass is reviewed

- [x] Make MCP servers discoverable, configurable, testable and diagnosable from the product’s Settings surface.
- [x] Add bounded upload handling and cleanup so arbitrary-size inputs do not consume unbounded local disk (streamed byte ceiling; disk reserve; concurrent in-flight byte reservations; partial-file cleanup; Composer surfaces server errors).
- [x] Add a file-change review and undo workflow with durable checkpoints for agent edits.
- [ ] Define task-resume checkpoints, durable steering, and recovery semantics for long-running work, including uncertain tool side effects and provider/quota pauses.

## Product constraints

- One main agent and one steering conversation; Settings is the single provider/connector setup surface.
- Show meaningful work state and outcomes without flooding the user with raw internals.
- Every claimed capability must work through a complete user-visible path. Prefer focused vertical slices; no placeholder UI or disconnected scaffolding.
- Keep local data and full-machine tool access treated as sensitive capabilities; make consequential actions and state changes visible and recoverable.
- [x] (COORDINATOR) Protect streamed uploads with aggregate in-flight byte accounting so concurrent uploads preserve the free-space reserve | files=app/api/upload/route.ts | evidence=typecheck passed; user-flow upload not manually exercised
- [x] (COORDINATOR) Complete missing Activity icon dependency and restore typecheck | files=components/icons.tsx | evidence=shared icon added; latest typecheck and build pass
- [ ] (COORDINATOR) Current owner map: Timeline readability, copy affordances, file diff + undo | owner=cline-01 | status=in-progress
- [ ] (COORDINATOR) Current owner map: provider catalog, model checks, endpoint and connector setup | owner=Grok Bot | status=in-progress
- [ ] (COORDINATOR) Current owner map: 24h recovery, quota waiting, uncapped loop, event persistence | owner=agent-9f59 | status=in-progress
- [ ] (COORDINATOR) Current owner map: durable task queue, run ledger, Activity view | owner=atlas-runtime | status=in-progress
- [ ] (COORDINATOR) Current owner map: provider-search fallback and canonical localhost handling | owner=agent-opencode-1 | status=done, sync f196e82b3
- [ ] (cline-01) Timeline readability, copy affordances, file diff + undo | owner=cline-01 | status: reviewable diff + undo shipped; copy-buttons + diff-collapse + restore hardening verified (tsc green, screenshots, 0 console errors)
- [x] (COORDINATOR) Write the 24h endurance acceptance matrix for quota, restart, context, steering, artifacts and disk growth | owner=COORDINATOR | evidence=ENDURANCE_ACCEPTANCE.md | status=criteria only; no 24-hour soak claimed
- [ ] (COORDINATOR) 24h acceptance gates: quota/outage backoff without spinning; restart repairs tool calls by ID and inspects before retry; newest steer survives compaction; stop/continue works; plan/artifacts/events persist; disk/history growth stays bounded; task state is clear in UI | owner=all lanes | status=acceptance criteria, not a claim that one 24h soak has passed
- [x] (COORDINATOR) Show actionable upload errors in the Composer chip (size, disk reserve, network) | files=components/Composer.tsx | evidence=server error text shown inline and as tooltip; typecheck/build pass
- [x] (COORDINATOR) Remove the plaintext owner token from the running server environment; validate against a configured digest | files=lib/auth.ts + deploy config | evidence=Grok Bot reports d481ac19f live with hash-only server env and real-token preflight succeeded; external HTTP auth gate confirmed
- [ ] (COORDINATOR) Fix compaction tail selection so the newest user steering message stays verbatim | files=lib/agent.ts | owner=agent-9f59 | status=blocking 24h acceptance and e2e compaction case
- [x] (PRODUCT_UI_REVIEW) Hide decorative icon SVGs from assistive technology and keyboard focus | owner=PRODUCT_UI_REVIEW | file=components/icons.tsx
- [x] (ENDURANCE_REVIEW) Make pause, cancel and resume single-owner state transitions; prevent scheduler requeue and stale run completion from overriding user action | files=app/api/runtime/tasks/[id]/route.ts,lib/runtime/scheduler.ts,lib/runtime/tasks.ts | owner=atlas-runtime | evidence=run registry + abort + stale-completion guards; pause is blocked/input and cannot be auto-requeued; owner reports runtime suite 20/20
- [ ] (COORDINATOR) Make pause/cancel wait for the active run to actually settle (with visible stopping state or bounded timeout) so a signal-ignoring tool cannot continue side effects after the API reports stopped | files=lib/runtime/scheduler.ts,app/api/runtime/tasks/[id]/route.ts,lib/runtime/types.ts,components/Activity.tsx | owner=atlas-runtime | follow-up after F5 state ownership fix
- [ ] (ENDURANCE_REVIEW) Persist provider quota/outage cooldowns so process restart does not immediately retry exhausted providers | files=lib/router.ts,lib/store.ts | owner=unclaimed | persist exhaustion bench deadline and restore backoff after restart
- [ ] (ENDURANCE_REVIEW) Cap and rotate shell spill/background logs; stream or bound foreground capture and clean up agent-owned background processes | files=lib/tools/shell.ts | owner=unclaimed (current file claim cline-01) | 24h disk/memory growth
- [ ] (ENDURANCE_REVIEW) Bound archived session events and avoid reading the full JSONL archive for each page | files=lib/store.ts,lib/agent.ts,app/api/sessions/[id]/events/route.ts | owner=unclaimed (current claims agent-9f59) | 24h storage and paging cost
- [ ] (ENDURANCE_REVIEW) Add terminal-task retention that prunes task rows, per-task ledgers, and artifact metadata without deleting kept deliverables | files=lib/runtime/tasks.ts,lib/runtime/ledger.ts,lib/runtime/artifacts.ts,lib/runtime/store.ts | owner=unclaimed (current claims atlas-runtime) | cross-task disk growth
- [x] (integration_review) Redact short secret values consistently in connection APIs | files=lib/connections.ts,app/api/providers/route.ts | evidence=Grok Bot reports 4/6-char secrets absent from API response in sync 74f216f7b
- [ ] (integration_review) Make every advertised tool key usable or label it unsupported | files=lib/presets.ts:145-174; components/Settings.tsx:63-66; lib/tools/shell.ts:12-30; lib/tools/web.ts:111-118 | catalog blurbs claim GitHub/Vercel/Replicate/etc uses, but only searchKeys is consumed by a built-in tool and shell child env omits toolEnv; wire scoped capability or remove capability claims
- [x] (integration_review) Clarify imported Claude MCP configuration source on server installs | files=components/Settings.tsx | evidence=copy names the machine Swarm runs on (sync 74f216f7b)
- [x] (integration_review) Give Settings list and connection row checks actionable network/API failure states | files=components/Settings.tsx | evidence=load/test/save/toggle/remove handle network errors and non-JSON answers (sync 74f216f7b)
- [x] (integration_review) Catch OpenRouter OAuth key-exchange transport failures and return to Settings with a reason | files=app/api/connect/openrouter/callback/route.ts | evidence=fetch errors/timeouts redirect with useful reason (sync 74f216f7b)
- [ ] (COORDINATOR) Explain the server-mode egress policy for custom providers and browser access; private/LAN endpoints are blocked by default and need a deliberate admin opt-in if supported | files=components/Settings.tsx,deploy config | coordinate with Grok Bot (deploy); do not silently imply private endpoints are reachable
