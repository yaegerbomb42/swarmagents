# lib/router — per-user LLM provider/model/key router

Pure, typed core (no I/O except the pluggable `RouterStore` and injected `Clock`).
Original design and code by Hydrogen; reviewed, fixed, and wired by the swarm.

- `router.ts` — `SwarmRouter`: candidate filtering (capabilities, allowed/excluded
  targets, paid policy, budgets, auth/credit/rate state), free-first partitioning,
  score = priority + quota headroom + health (EWMA latency/TTFT/error, idle-decayed)
  + quality (short-prompt score, long-prompt garble penalty) + stickiness.
  `routeAndAcquire` returns `{ decision, lease }`; callers report outcomes with
  `recordOutcome` (`success | rate_limit_429 | quota_402 | auth_401 | server_5xx |
  timeout | garbled | empty`).
- `rolling-window.ts` — RPM/TPM/daily counters and rate-limit header parsing.
- `quality.ts` — long-prompt detection and garble/empty heuristics.
- `fair-queue.ts` — least-recently-served tenant queue; holds the global slot until release.
- `types.ts` — zod schemas for providers, keys, policy, requests, decisions, snapshots.

Gateway glue lives in `lib/runtime/llm-routing.ts` (per-user `router_state.json`,
key-id hashing — key values never leave memory) and `lib/runtime/llm-gateway.ts`
(router first, legacy KeyPool fallback on any router error; `SWARM_LLM_ROUTER=off`
disables the router).
