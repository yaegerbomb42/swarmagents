# SwarmAgents master todo

## Current pass — owned, outcome-based work

- [x] **Task status at a glance** (UI): show live/idle state, current action, elapsed time and plan progress in the single-task view; avoid showing the same plan twice; keep Composer as the only steering surface.
- [x] **Provider setup works end to end** (Integrations): implement the model discovery/connection check route already called by Settings, with useful failure handling and no key leakage.
- [x] **Safe recovery after a process interruption** (Runtime): repair incomplete tool-call transcripts on load, make uncertain side effects explicit, and persist the recovered checkpoint without replaying operations.
- [ ] **Review the combined product slice** (Coordinator): inspect the diff and check that the three improvements fit the existing task flow; record observed verification and any remaining defects.

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
- [x] (COORDINATOR) Complete missing Activity icon dependency and restore typecheck | files=components/icons.tsx | status=in-progress
- [ ] (COORDINATOR) Current owner map: Timeline readability, copy affordances, file diff + undo | owner=cline-01 | status=in-progress
- [ ] (COORDINATOR) Current owner map: provider catalog, model checks, endpoint and connector setup | owner=Grok Bot | status=in-progress
- [ ] (COORDINATOR) Current owner map: 24h recovery, quota waiting, uncapped loop, event persistence | owner=agent-9f59 | status=in-progress
- [ ] (COORDINATOR) Current owner map: durable task queue, run ledger, Activity view | owner=atlas-runtime | status=in-progress
- [ ] (COORDINATOR) Current owner map: provider-search fallback and canonical localhost handling | owner=agent-opencode-1 | status=done, sync f196e82b3
- [ ] (cline-01) Timeline readability, copy affordances, file diff + undo | owner=cline-01 | status: reviewable diff + undo shipped; copy-buttons + diff-collapse + restore hardening verified (tsc green, screenshots, 0 console errors)
- [x] (COORDINATOR) Write the 24h endurance acceptance matrix for quota, restart, context, steering, artifacts and disk growth | owner=COORDINATOR | evidence=ENDURANCE_ACCEPTANCE.md | status=criteria only; no 24-hour soak claimed
- [ ] (COORDINATOR) 24h acceptance gates: quota/outage backoff without spinning; restart repairs tool calls by ID and inspects before retry; newest steer survives compaction; stop/continue works; plan/artifacts/events persist; disk/history growth stays bounded; task state is clear in UI | owner=all lanes | status=acceptance criteria, not a claim that one 24h soak has passed
- [x] (COORDINATOR) Show actionable upload errors in the Composer chip (size, disk reserve, network) | files=components/Composer.tsx | status=in-progress
- [ ] (COORDINATOR) Remove the plaintext owner token from the running server environment; validate against a configured digest | files=lib/auth.ts + deploy config | owner=agent-9f59 + Grok Bot (deploy) | status=required before next deploy | same-UID child processes can read /proc/<pid>/environ
- [ ] (COORDINATOR) Fix compaction tail selection so the newest user steering message stays verbatim | files=lib/agent.ts | owner=agent-9f59 | status=blocking 24h acceptance and e2e compaction case
- [x] (PRODUCT_UI_REVIEW) Hide decorative icon SVGs from assistive technology and keyboard focus | owner=PRODUCT_UI_REVIEW | file=components/icons.tsx
- [x] (ENDURANCE_REVIEW) Make pause, cancel and resume single-owner state transitions; prevent scheduler requeue and stale run completion from overriding user action | files=app/api/runtime/tasks/[id]/route.ts,lib/runtime/scheduler.ts,lib/runtime/tasks.ts | owner=atlas-runtime | evidence=run registry + abort + stale-completion guards; pause is blocked/input and cannot be auto-requeued; owner reports runtime suite 20/20
- [ ] (ENDURANCE_REVIEW) Persist provider quota/outage cooldowns so process restart does not immediately retry exhausted providers | files=lib/router.ts,lib/store.ts | owner=unclaimed | persist exhaustion bench deadline and restore backoff after restart
