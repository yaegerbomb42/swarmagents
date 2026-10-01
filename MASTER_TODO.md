# SwarmAgents master todo

## Current pass — owned, outcome-based work

- [x] **Task status at a glance** (UI): show live/idle state, current action, elapsed time and plan progress in the single-task view; avoid showing the same plan twice; keep Composer as the only steering surface.
- [ ] **Provider setup works end to end** (Integrations): implement the model discovery/connection check route already called by Settings, with useful failure handling and no key leakage.
- [x] **Safe recovery after a process interruption** (Runtime): repair incomplete tool-call transcripts on load, make uncertain side effects explicit, and persist the recovered checkpoint without replaying operations.
- [ ] **Review the combined product slice** (Coordinator): inspect the diff and check that the three improvements fit the existing task flow; record observed verification and any remaining defects.

## Next, only after the current pass is reviewed

- [ ] Make MCP servers discoverable, configurable, testable and diagnosable from the product’s Settings surface.
- [ ] Add bounded upload handling and cleanup so arbitrary-size inputs do not consume unbounded local disk.
- [ ] Add a file-change review and undo workflow with durable checkpoints for agent edits.
- [ ] Define task-resume checkpoints, durable steering, and recovery semantics for long-running work, including uncertain tool side effects and provider/quota pauses.

## Product constraints

- One main agent and one steering conversation; Settings is the single provider/connector setup surface.
- Show meaningful work state and outcomes without flooding the user with raw internals.
- Every claimed capability must work through a complete user-visible path. Prefer focused vertical slices; no placeholder UI or disconnected scaffolding.
- Keep local data and full-machine tool access treated as sensitive capabilities; make consequential actions and state changes visible and recoverable.
- [ ] (COORDINATOR) Protect large streamed uploads with per-file and disk-reserve checks | files=app/api/upload/route.ts | status=in-progress
- [x] (COORDINATOR) Complete missing Activity icon dependency and restore typecheck | files=components/icons.tsx | status=in-progress
- [ ] (COORDINATOR) Current owner map: Timeline readability, copy affordances, file diff + undo | owner=cline-01 | status=in-progress
- [ ] (COORDINATOR) Current owner map: provider catalog, model checks, endpoint and connector setup | owner=Grok Bot | status=in-progress
- [ ] (COORDINATOR) Current owner map: 24h recovery, quota waiting, uncapped loop, event persistence | owner=agent-9f59 | status=in-progress
- [ ] (COORDINATOR) Current owner map: durable task queue, run ledger, Activity view | owner=atlas-runtime | status=in-progress
- [ ] (COORDINATOR) Current owner map: provider-search fallback and canonical localhost handling | owner=agent-opencode-1 | status=done, sync f196e82b3
