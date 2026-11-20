# SwarmAgents Master Plan: winning on the execution layer

Source: four adversarial strategy prompts Jimmy ran through Hydrogen (Gemini) on 2026-11-19, merged and reduced to buildable PRs.
Status: proposal. Jimmy picks the order. Each PR below goes on the swarm board as a task with full spec, tests and UI.

## Thesis

Live VMs, readable logs, screen view and bring-your-own-model are table stakes. OpenHands, Cursor Cloud Agents, Devin, Claude Code and Manus all ship them. We win by owning what their architectures and business models make expensive to copy:

1. **Verified, not self-graded, output.** A different agent, model family or VM checks the work.
2. **Cheap models performing like frontier ones.** Intelligence lives in the harness (oracles, context packing, contracts, escalation), not in the weights.
3. **A recoverable machine.** Snapshot, rewind and fork the whole VM, not just the files.
4. **Delegation without fear.** Secrets never enter the VM, writes get previewed, and receipts are grounded in the hypervisor.

## Idea map (deduplicated)

The four reports overlapped heavily. Here is where each idea landed:

| Epic | Merges these report ideas |
|---|---|
| E1 Adversarial verification | Cross-VM adversarial QA (R1 #1), Clean-room blind testing (R3 #1), Red/Blue hardening (R3 #3) |
| E2 Cheap-model harness | Oracle-gated best-of-N (R2 #1), AST-sliced L1 context (R2 #2), Contract-first leaves (R2 #3) |
| E3 Cost router and breakers | Intra-task escalation and dollar caps (R1 #4), Telemetry-triggered escalation (R2 #4) |
| E4 Machine time travel | Log-synced rewind and fork (R1 #2), CoW snapshots and counterfactual forks (R4 #1) |
| E5 Secret airlock and auth takeover | Host-proxy secret injection (R1 #3), Capability-lease airlock with the paired node (R4 #2) |
| E6 Shadow preview and receipts | Blast-radius dry run (R4 #3), Proof-of-intent receipts (R4 #4) |
| E7 Compile the run | Zero-token deterministic replay with self-heal (R1 #5) |
| Deferred | Architecture bake-offs (R3 #2) and veto-agent governance (R3 #4). Both are strong demos, but they come after E1 to E3 because they reuse the same isolation and gating primitives. |

## Recommended order and PRs

The order maximizes leverage per week: harness wins first (cheap and visible on every run), then the moat features.

### Phase 1: make cheap models reliable (E2 + E3)
Builds on `lib/router`, `lib/providers` (p1) and `vendor/claude-code-mini` (archived PR #215, whose `contextGovernor.ts` already enforces 8,192 tokens).

- **PR 1.1 Oracle gate.** Apply each diff in a scratch copy first. Run tsc, pyright or cargo check, plus lint and the affected tests. Only commit patches that pass. Failed attempts are evicted from history; the retry gets just the diagnostic plus the symbol's definition.
  - Accept: a unit test with a seeded broken patch that never lands, and a log line "oracle: 2/3 candidates rejected".
- **PR 1.2 Best-of-N across model families.** On non-trivial edits, send 2 to 3 candidates (for example DeepSeek, Qwen and GLM) in parallel and take the first one that passes the oracle. Make N and the family list configurable per role.
- **PR 1.3 L1 context packer.** Rebuild the prompt each turn instead of appending to it. Fixed budgets: state ledger about 600 tokens, AST skeleton about 1,500, active working set about 3,500, reserve about 2,400. Port and generalize the claude-code-mini governor and astSlicer.
- **PR 1.4 Contract-first mode.** For multi-file tasks, turn 1 may only output signatures, stubs and failing tests, which are then locked read-only. Each leaf runs as its own stateless micro-task.
- **PR 1.5 Watchdog and escalation.** Hash each patch's AST and each error signature. Trip on repeats, A/B oscillation, two identical oracle failures, or a cheat diff (deleted assertions, `@ts-ignore`, broadened catches). On a trip, send a 3k-token bundle to the escalator model for a root-cause plan only, then drop back to the cheap model.
- **PR 1.6 Dollar circuit breaker.** A per-run dollar cap, live cost per step in the log, and a hard freeze with an alert when the cap is hit.
- **Metrics:** oracle pass@1 vs pass@k, cost per merged task, turns per task, and escalation rate (target 10% of turns or less).

### Phase 2: never grade your own homework (E1)
Builds on the swarm board (`lib/board`), roles, the g6 test-writer and the VM drivers.

- **PR 2.1 Shared workspace network.** VMs in one workspace join a private bridge with hostnames like `builder.swarm.internal`, isolated from other workspaces.
- **PR 2.2 Adversarial gate.** When the builder marks a task done, a QA role starts on a different provider with no access to the builder's chat. It tests the live app against the acceptance criteria and blocks completion with screenshots and HTTP traces.
- **PR 2.3 Clean-room tester.** The tester sees only the locked spec and the public interfaces, never the implementation. A disagreement becomes a red conflict card showing both sides. Two-round cap, then the user decides.
- **PR 2.4 Red/Blue hardening (opt-in).** The red agent sees only the API surface plus a goal and can file a ticket only with a reproduced exploit. Runs in a throwaway sandbox with synthetic data and a 15-request or 3-minute limit.
- **Metrics:** defects caught before merge, conflict cards resolved, and false-positive rate.

### Phase 3: a recoverable machine (E4)
Builds on `lib/vm/docker-driver.ts` and the existing `harness.checkpoints`.

- **PR 3.1 Auto snapshots.** Take a copy-on-write snapshot (Docker commit or overlay layer first, CRIU or QEMU later) before each mutating shell step, and store the snapshot id on that log entry.
- **PR 3.2 Rewind and fork from the log.** A button on each log line clones that machine state into a new VM, with an optional model switch and a one-line correction.
- **Metrics:** mid-run recovery rate, and time until a user trusts background runs.

### Phase 4: delegation without fear (E5 + E6)
Builds on b5 full-auto policy, `lib/secrets` (f11 vault), g11 pairing and the egress setup.

- **PR 4.1 Secret airlock.** The VM only sees placeholders like `SWARM_KEY_STRIPE`. A host-side egress proxy swaps in the real secret, only for allowlisted domains. Prove it with a test where `env` and `curl evil.com` from the VM never reveal the secret.
- **PR 4.2 Pause and auth.** A persistent encrypted browser profile per workspace, plus a takeover mode: the user types the 2FA code on the VM screen, then clicks Hand Back.
- **PR 4.3 Capability leases.** Narrow, time-limited grants through the paired node (for example read-only `~/X` for 10 minutes, or 5 POSTs to one host). Approved leases become reusable policies.
- **PR 4.4 Blast-radius preview.** External writes are intercepted during the run and staged. The user sees one manifest of file diffs, queued HTTP calls and messages, then promotes or discards it in one click.
- **PR 4.5 Receipts.** A signed bundle per task with file diffs, process tree and egress log captured outside the LLM, linked from each narrated claim.
- **Metrics:** share of high-stakes tasks that are delegated, policy auto-clear rate, and receipt attach rate.

### Phase 5: compile the run (E7)
- **PR 5.1** adds "Compile to script" on finished runs: shell and Playwright steps are pulled from the structured log and parameterized in one LLM pass. Replays run without the LLM, and a repair agent starts only on a non-zero exit, preloaded with the failing step and a screenshot.

## Guardrails for every PR
- Board task with the full spec. The worker builds the whole feature, including tests and UI. Gate with `tsc`, `npm test` and `npm run build`.
- Every new agent loop has a turn or token cap and a human tie-breaker.
- Nothing runs on the host server. Agent actions stay inside the VM, or go through the paired node only with an explicit lease.
