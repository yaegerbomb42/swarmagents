# WHY.md — Omnexx Institutional Knowledge & Narrative Coherence (Mythos Core)

## 1. Overall Project Goals & Mission

**Omnexx** is a long-running autonomous coding agent CLI and VS Code extension built with TypeScript for Node ≥ 22.

- **Core Value Proposition**: "Set a goal, walk away, come back to commits." Omnexx executes multi-hour unattended coding runs against real repositories, verifying every change through tests, typechecks, and linters, and rolling back failures.
- **Model Agnostic & Cost-Conscious**: Built to run seamlessly across any LLM provider, including local free models (Ollama) with prompt caching optimization.

## 2. Architecture Overview & Critical Subsystems

- **CLI Core (`src/`)**: Autonomous loop orchestrating task decomposition, tool invocation, test verification, and automated git commits/rollbacks.
- **VS Code Extension (`vscode/`)**: Side panel interface providing real-time stats, step timelines, chat interaction, and model selection.
- **Deployment**: omnexx is a vendored snapshot inside SwarmAgents (`apps/swarmagents/vendor/omnexx`); it has no deploy pipeline of its own. SwarmAgents deploys from the monorepo root (`./deploy.sh`).
- **Benchmarks & Harness (`bench/`)**: Comparative benchmarks tracking autonomous agent task completion rates, prompt cache hits, and token costs.

## 3. Key Decisions & Hard-Learned Lessons

- **Branching Strategy**: The only long-lived branch is `main` (`next` branch retired as of 2026-10-11). Work is done via feature branches and merged to `main` only when CI is clean.
- **Quality Gates**: Every kept step must pass strict validation (`lint`, `typecheck`, `format:check`, `test:quick`). Bare vitest runs locally are avoided to prevent triggering slow chaos/e2e suites.
- **Atomic Rollbacks**: Any modification failing verification is immediately reverted to preserve clean git state.

## 4. Current Priorities & Active Constraints

- Node version requirement: Node ≥ 22.
- Primary roadmap items tracked in [docs/NEXT.md](file:///Users/dev/Desktop/omnexx/docs/NEXT.md) and [docs/TODO.md](file:///Users/dev/Desktop/omnexx/docs/TODO.md).
- Zero-secret policy: sensitive keys must always remain in environment variables.

## 5. Session History & Log

- **2026-10-28 (Session Init)**: Cloned `yaegerbomb42/omnexx` repository into `/Users/dev/Desktop/omnexx`. Initialized `WHY.md` institutional knowledge base. Working tree is clean on `origin/main`.
- **2026-10-28 (Release v0.21.1 / Extension 0.17.1)**:
  - Prepared release for VS Code Marketplace overhaul: bumped root `package.json` to `0.21.1` and `vscode/package.json` to `0.17.1`.
  - Replaced low-quality cropped snippet screenshot with high-fidelity visual assets ([`panel.png`](file:///Users/dev/Desktop/omnexx/vscode/media/panel.png), [`model-picker.png`](file:///Users/dev/Desktop/omnexx/vscode/media/model-picker.png), and [`demo.gif`](file:///Users/dev/Desktop/omnexx/vscode/media/demo.gif)).
  - Streamlined [vscode/README.md](file:///Users/dev/Desktop/omnexx/vscode/README.md) with 3-step quickstart and mode comparison matrix.
  - Updated marketplace descriptor in [vscode/package.json](file:///Users/dev/Desktop/omnexx/vscode/package.json).
  - Resolved duplicate assignment in `src/cli/program.ts` and duplicate import in `src/core/supervisor.ts`.
  - Updated [CHANGELOG.md](file:///Users/dev/Desktop/omnexx/CHANGELOG.md).
  - All unit tests, typechecks, ESLint, and Prettier checks passing.
- **2026-10-28 (Task 1: Prompt Cache Pinning & Dynamic State Quarantine)**:
  - Enforced `pinPrefix(req.system)` in Anthropic wire payload generation (`src/providers/anthropic.ts`).
  - Placed ephemeral dynamic session state (`ctx.volatilePrompt`) at the user prompt suffix.
  - Verified stable blocks come first with `cacheBreakpoint` exclusively on the last stable block before volatile blocks. PR #357.
- **2026-10-28 (Task 2: AST & Symbol-Level Outline Reader)**:
  - Extended symbol extraction in `src/tools/outline.ts` to compute exact line spans (`lines X-Y`) using bracket/indent matchers (`findBraceEndLine`, `findPythonEndLine`).
  - Added support for top-level `const fn = () =>` / `const fn = function` arrow/anonymous function declarations.
  - Formatted outline output as `kind name (lines X-Y)`. PR #360.
- **2026-10-28 (Task 3: Tool Output Compactor & Error-Trace Reducer)**:
  - Enhanced `src/tools/output-compress.ts` to fold high-volume package manager noise (npm deprecation warnings, audit notices, funding prompts) and build tickers (vite module transformation lines) into clean single-line summaries while guaranteeing that error lines and failure traces are never suppressed.
  - Stripped git tutorial advice (`use "git add..."`) from command output to free up LLM context space.
  - Collapsed excessive blank lines.
  - Added unit test suite in `test/unit/tools/output-compress.test.ts` verifying >50-80% line reduction on noisy failing test runs with 100% assertion and project stack frame retention. PR #367.
- **2026-10-28 (Task 4: Isolated Subagent Research Sandbox)**:
  - Hardened read-only subagent tool constraints and context boundary: subagents can consume large context (up to 50k tokens) exploring code and reading web/docs, but hand back only a tightly bounded, synthesized executive summary (capped at 1,500 chars / ~350 tokens) with key file:line anchors (at most 8 deduplicated paths) to the orchestrator.
  - Added strict tool denial (`safeSubagentTools`) stripping modifying and execution tools (`bash`, `write_file`, `str_replace`, `apply_patch`, `patch`, `task`, `todo`).
  - Consolidated `formatSubagentResult` into a single canonical implementation in `src/agent/subagent.ts` used across `task` and `agent` tools.
  - Added unit test suite in `test/unit/agent/subagent-isolation.test.ts` verifying tool denial, result truncation, file deduplication, out-of-band artifact emission, and `taskTool` execution. PR #368.
- **2026-10-28 (Task 5: Pre-Flight Acceptance Contract Gate)**:
  - Enforced a deterministic 3-part contract schema (`targetFiles`, `hypothesis`, `verificationCommand`) via `src/core/contract.ts` and `define_contract` tool (`src/tools/contract.ts`).
  - Integrated `ContractGate` into the core agent execution cycle (`src/core/cycle.ts`), validating file edits in `src/tools/edit.ts` (`write_file`, `str_replace`, etc.) and `src/tools/replace-lines.ts`.
  - Rejects modifying any file outside the contract's declared `targetFiles` until contract is updated, eliminating hallucinated file scatter. PR #373.
- **2026-10-28 (Task 6: Anti-Doom-Loop Ratchet & 2-Strike Rollback)**:
  - Implemented `DoomLoopRatchet` in `src/core/doom-loop-ratchet.ts` to break recurring agent failure cycles.
  - Implemented rolling hash deduplication of tool errors (`normalizeErrorSignature` & `hashErrorSignature`): identical tool failures twice in a row trigger execution interception with a strategy shift prompt (`Strategy failed twice with error: ... Roll back the file and propose an alternative strategy.`).
  - Implemented the "Zero Partial Work" rollback ratchet on verification failures: when test/verification commands fail on dirty files, exactly 1 targeted fix turn is allowed. If verification fails a second time, modified files are immediately and atomically rolled back via git to the clean baseline state, preventing edit spirals.
  - Integrated into `src/agent/loop.ts` and `src/core/cycle.ts`. Added unit test suite in `test/unit/core/doom-loop-ratchet.test.ts`. PR #375.
- **2026-10-28 (Task 7: Milestone Compactor with Checkpoint Folding)**:
  - Created `src/agent/milestone-compactor.ts` with `foldMilestoneCheckpoint`, `formatMilestoneRecap`, `extractFilesTouched`, and `extractVerificationCommand`.
  - Automatically folds intermediate trial-and-error discussion turns (up to 10 turns) into a structured 3-line milestone recap (`Milestone X complete: ... - Changed: ... - Verified via: ...`) upon subtask/milestone commit, preserving the system prompt and reducing working context by >70-80% for subsequent subtasks.
  - Exported through `src/agent/compaction.ts` and added unit test suite in `test/unit/agent/milestone-compactor.test.ts`. PR #376.
- **2026-11-05 (Task 9: Optimal Cache-Aware Context Planner & Supersede Index)**:
  - Replaced naive per-turn context compaction heuristics with a unified, cache-aware, causally informed Context Engine 2.0 (`ContextPlanner` and `SupersedeIndex`).
  - Implemented `TokenCounter` in `src/core/token-count.ts` with `WeakMap<ContentBlock, TokenEstimate>` memoization, provider usage calibration via EMA, and deterministic key sorting.
  - Implemented `SupersedeIndex` and `LineIntervalSet` in `src/agent/supersede-index.ts` with interval line-range coverage across edit epochs, shell mutation detection, and 64-bit FNV-1a MinHash LSH near-duplicate clustering.
  - Implemented `ContextPlanner` in `src/agent/context-planner.ts` with multiple-choice representation lattice (`FULL -> DIGEST -> STUB`), representation floors for error traces/active edits, CPU-only structural digesters, and `foldPaysOff` cache-epoch gating.
  - Enforced strict `tool_use` and `tool_result` pairing invariants and message 0 immutability in `applyPlan()`.
  - Refactored `src/agent/budget-guard.ts` to delegate to `ContextPlanner` while maintaining 100% backwards-compatible public signatures.
  - Verified with comprehensive test suite in `test/unit/agent/context-planner.test.ts` (11 tests) and passed the entire repository test suite (317 test files, 2,061 tests green). PR #393.
- **2026-11-07 (Task 10: Claude Code/Cline Agent Harness Parity & Minimal VS Code UI Overhaul)**:
  - Eliminated the aggressive 7-turn amnesia cadence in `src/agent/rolling-memory.ts` and `src/config/schema.ts` (`DEFAULT_CONDENSE_EVERY = 20`, `DEFAULT_KEEP_TURNS = 6`, `compact_keep_turns = 6`).
  - Switched default `memory` mode from `'rolling'` to `'full'` (matching Claude Code and Cline full-context retention with token-threshold compaction and micro-pruning).
  - Fixed `compactAt` in `src/core/cycle.ts` and `src/tui/code-chat.ts` to respect `config.context.compact_at` instead of being disabled by `Number.MAX_SAFE_INTEGER`.
  - Overhauled VS Code extension styling (`vscode/media/chat.css`) for a minimal, custom-designed aesthetic: clean borderless typography, subtle rounded user message pills, soft vertical guide on assistant replies, sleek pill clusters for tool executions, and a modern floating composer input dock.
  - Hardened tool argument parser (`src/providers/repair.ts`) with `escapeControlCharsInStrings` to handle literal unescaped newlines/tabs inside JSON string literals and resilient boundary extraction for surrounding conversational prose.
  - Enhanced doom-loop ratchet precision in `src/agent/loop.ts` by keying errors on `toolName + targetPath` rather than varying raw input slices, preventing hallucinated edit retry loops from evading the 2-strike intervention.
  - Tested on Nemotron models (`nvidia/nemotron-3-ultra-550b-a55b` via OpenRouter / NVIDIA NIM): verified that multi-turn reasoning and tool invocation pairs remain intact past turn 7 without premature truncation or context loss.
- **2026-11-08 (Task 12: SWE-bench Remediation, Precision Edit Recovery & Preflight Architecture)**:
  - Phase 0 SWE-bench Remediation:
    - Fixed `src/swe-bench/patch-diff.ts` by removing `--no-prefix` to generate valid `a/` and `b/` unified diffs compatible with standard `git apply` and `patch -p1`.
    - Added `git add -N .` so untracked and uncommitted files are properly tracked in patch diff comparisons.
    - Updated `src/swe-bench/skeleton.ts` to use AST line boundaries (`sym.line`..`sym.endLine`) instead of substring `indexOf` to eliminate false comment/import matches.
    - Upgraded `src/swe-bench/reproduce.ts` to use `runShell` with process-group kill (`-pid`) and Docker awareness, added symptom validation rejecting syntax/import errors, and guaranteed workspace cleanup in `finally` blocks.
  - Phase 1 Preflight & Precision Edits:
    - Updated `src/tools/anchors.ts` with dynamic span resolution ($s + \text{span} \pm 10$ lines) for multi-line anchor hashes, allowing successful anchor location even when prior edits inserted or removed interior lines.
    - Hardened `src/tools/output-compress.ts` with `foldCompilerErrors()` (>5 errors collapsed to first 3), `foldPytestWarnings()` (collapsing pytest warning sections), and `MAX_COMPRESSED_CHARS` (hard 2,500-char cap).
    - Built self-healing symbol-level matching in `src/tools/edit-recovery.ts` via `findMatchingSymbol()`, snapping recovery windows in `closestRegion()` to exact function/class boundaries when edits drift.
    - Implemented `src/verify/preflight-types.ts`, `src/verify/diagnostics.ts`, and `src/verify/preflight.ts` providing normalized diagnostics across LSP, TSC, and ESLint, with a bounded 4,000ms execution hub.
    - Verified against Vitest: 328/328 test files and 2,221 tests passing green with 0 type errors.
- **2026-11-08 (Milestone: 71/71 Engineering Overhaul & 6-Subsystem Frontier Model Audits Complete)**:
  - **71/71 Steps 100% Complete & Merged (`origin/main`)**:
    - Completed all phases: Phase 0 (SWE-bench), Phase 1 (Preflight & Precision Edits), Phase 2 (Autonomous Loop Ratchets), Phase 3 (Wave-Pipelined Concurrency), Phase 4 (Provider KV-Cache Pinning), Phase 5 (Context Architecture & Representation Lattice), Phase 6 (Intelligent Model Routing & Cascade), Phase 7 (OGTS Search & Behavioral Clustering), Phase 8 (MicroVM & Workspace Isolation Sandbox), Phase 9 (VS Code Enterprise Polish & Design System Tokens).
  - **Post-Roadmap 6-Subsystem Audits (All 6 Verified & Merged to `main`)**:
    - **Subsystem 1 (Agent Runtime, Concurrency & Interrupt Engine, PR #424)**: Verified mid-wave `AbortSignal` handling without unhandled rejections; enforced strict 1-to-1 `tool_use` to `tool_result` index and `toolUseId` matching in `executeToolWaves`; guarded `maxConcurrency` boundaries. (8/8 tests in `test/unit/agent/runtime-audit.test.ts`).
    - **Subsystem 2 (Preflight Verification, Autofix & Diagnostics Hub, PR #423)**: Verified 4,000ms hard ceiling; fixed background disk mutation bug on aborted preflights in `src/verify/preflight.ts`; verified 0-based LSP to 1-based editor coordinate conversions; added `closeAll`/`stopAll` lifecycle methods to `LspClientManager`. (11/11 tests in `test/unit/verify/preflight-audit.test.ts`).
    - **Subsystem 3 (Provider Wire Protocols, Dual-Breakpoints & KV-Cache Pinning, PR #422)**: Fixed non-deterministic JSON argument serialization in `toChatMessages` (`src/providers/openai-compat.ts`) and tool schema hashing in `computePrefixHash` (`src/agent/context.ts`) using `stableJsonStringify`; verified Anthropic max-4 breakpoint budget compliance. (11/11 tests in `test/unit/providers/provider-audit.test.ts`).
    - **Subsystem 4 (Context Architecture & 3-Level Prompt Topology, PR #421)**: Fixed `$REPO` canonicalization prefix collisions; fixed `clampSlotTail`/`clampSlot` tiny-budget truncation; guaranteed `prefixHash` is frozen across Level-2 dynamic turns. (11/11 tests in `test/unit/core/context-audit.test.ts`).
    - **Subsystem 5 (Model Routing, Cascade Classifier & Fast-Path Engine, PR #419)**: Fixed 5 fast-path false positives in `src/router/cascade-router.ts` by expanding `MUTATION_RE` (`rm`, `replace`, `mv`) and gating all branches on mutation checks; verified synchronous $O(1)$ contract and Tier 3 threshold escalation ($\ge 100\text{k}$ tokens / $>3$ files). (22/22 tests in `test/unit/router/cascade-audit.test.ts`).
    - **Subsystem 6 (SWE-bench Benchmark Extraction & Patch Engine, PR #420)**: Fixed newline stripping in `src/swe-bench/patch-diff.ts` that caused `git apply` corrupt patch rejections; added `ensureGitApplyPatch()` and `preservePrefixes`; verified nested untracked file capture via `git add -N .`; verified process-group kill (`-pid`) on repro timeout. (8/8 tests in `test/unit/swe-bench/swebench-audit.test.ts`).
  - **Full Validation**: 71/71 tests passing across the 6 subsystem audit suites; `npm run typecheck` passes with exit code 0; formatting clean.
