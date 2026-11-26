// Provider executors for the multi-provider eval.
//
// - `ScriptedProviderExecutor` replays a deterministic, scripted solve per
//   task so the suite is stable in CI and unit tests. It applies the task's
//   `solution` delta (writing solution files and removing `deleted` paths)
//   and returns fixed, deterministic usage metrics derived from the task id
//   — the same task always replays the same turns/tokens.
// - `LiveProviderExecutor` is the seam for driving a real Claude Code
//   invocation against a live provider and VM. It intentionally is *not*
//   wired to real credentials here (no secrets, no network in CI), but it
//   documents the contract and is unit-tested with a stub delegate.

import type {
  ProviderExecutor,
  ProviderExecutorResult,
  ProviderEvalTask,
  ProviderRunContext,
} from "./provider-types";
import { hashSeed, jitter } from "./driver";

export interface ScriptedExecutorOptions {
  /** When true, the scripted solve writes the *starting* state (a miss). Default false. */
  fail?: boolean;
  /** Turns the scripted run reports. Uses a deterministic default when unset. */
  turns?: number;
  /** Input tokens the scripted run reports. Uses a deterministic default when unset. */
  inputTokens?: number;
  /** Output tokens the scripted run reports. Uses a deterministic default when unset. */
  outputTokens?: number;
}

export class ScriptedProviderExecutor implements ProviderExecutor {
  constructor(private readonly options: ScriptedExecutorOptions = {}) {}

  async run(task: ProviderEvalTask, _ctx: ProviderRunContext): Promise<ProviderExecutorResult> {
    const seed = hashSeed(task.id);
    const turns = this.options.turns ?? jitter(seed, 6, 14);
    const inputTokens = this.options.inputTokens ?? jitter(seed + 1, 8000, 16000);
    const outputTokens = this.options.outputTokens ?? jitter(seed + 2, 1200, 4000);
    const wallClockMs = turns * jitter(seed + 3, 900, 1400);

    if (this.options.fail) {
      // A miss: leave the workspace at its starting state and report usage.
      return {
        files: task.setupFiles,
        deleted: [],
        metrics: { totalTurns: turns, totalInputTokens: inputTokens, totalOutputTokens: outputTokens, wallClockMs },
      };
    }

    return {
      files: task.solution.files,
      deleted: task.solution.deleted ?? [],
      metrics: { totalTurns: turns, totalInputTokens: inputTokens, totalOutputTokens: outputTokens, wallClockMs },
    };
  }
}

/**
 * Contract for a live runner that drives a real provider. Not wired to real
 * credentials here; see `provider-runner.ts` for the driver that composes a
 * delegate. Kept as an interface so a live implementation can be added
 * without touching the scripted path.
 */
export interface LiveRunDelegate {
  (
    task: ProviderEvalTask,
    ctx: ProviderRunContext,
    workspaceDir: string,
  ): Promise<ProviderExecutorResult>;
}
