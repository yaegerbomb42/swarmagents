/**
 * fanout-executor.ts — bounded parallel sub-worker executor for `fan_out_workers`.
 *
 * Enforces:
 *   - maxConcurrency <= 5
 *   - per-worker turn cap (task.maxTurns)
 *   - shared parent budget (stops launching queued workers once budget is exhausted)
 *   - partial-failure resilience (one worker error never aborts sibling workers)
 */

import type { FanOutArguments, FanOutTaskInput } from "./fanout-mcp";

export interface FanOutWorkerOutcome {
  ok: boolean;
  summary?: string;
  error?: string;
  turns?: number;
  costUsd?: number;
}

export interface FanOutWorkerResult {
  id: string;
  ok: boolean;
  summary?: string;
  error?: string;
  turns: number;
  costUsd: number;
  durationMs: number;
}

export interface FanOutAggregateResult {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  totalCostUsd: number;
  budgetExhausted: boolean;
  results: FanOutWorkerResult[];
}

export interface ExecuteFanOutOptions {
  runWorker: (task: FanOutTaskInput, signal?: AbortSignal) => Promise<FanOutWorkerOutcome>;
  /** Shared parent USD budget ceiling across all workers in this fan-out. */
  parentBudgetUsd?: number;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Execute bounded parallel sub-workers and aggregate all per-worker outcomes
 * into one structured result for A1's `tool_result`.
 */
export async function executeFanOutWorkers(
  args: FanOutArguments,
  options: ExecuteFanOutOptions,
): Promise<FanOutAggregateResult> {
  const now = options.now ?? Date.now;
  const results: FanOutWorkerResult[] = new Array(args.tasks.length);
  let nextIdx = 0;
  let spentUsd = 0;
  let budgetExhausted = false;

  async function workerLoop(): Promise<void> {
    for (;;) {
      if (options.signal?.aborted) return;
      const idx = nextIdx++;
      if (idx >= args.tasks.length) return;
      const task = args.tasks[idx];

      if (options.parentBudgetUsd !== undefined && spentUsd >= options.parentBudgetUsd) {
        budgetExhausted = true;
        results[idx] = {
          id: task.id,
          ok: false,
          error: "Skipped: shared parent budget exhausted.",
          turns: 0,
          costUsd: 0,
          durationMs: 0,
        };
        continue;
      }

      const startedAt = now();
      try {
        const outcome = await options.runWorker(task, options.signal);
        const cost = typeof outcome.costUsd === "number" && Number.isFinite(outcome.costUsd) && outcome.costUsd >= 0
          ? outcome.costUsd
          : 0;
        spentUsd += cost;
        results[idx] = {
          id: task.id,
          ok: outcome.ok,
          ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          turns: outcome.turns ?? 0,
          costUsd: cost,
          durationMs: Math.max(0, now() - startedAt),
        };
      } catch (err) {
        results[idx] = {
          id: task.id,
          ok: false,
          error: err instanceof Error && err.message ? err.message : "Worker failed.",
          turns: 0,
          costUsd: 0,
          durationMs: Math.max(0, now() - startedAt),
        };
      }
    }
  }

  const concurrency = Math.max(1, Math.min(args.maxConcurrency, args.tasks.length));
  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));

  for (let i = 0; i < args.tasks.length; i++) {
    if (!results[i]) {
      results[i] = {
        id: args.tasks[i].id,
        ok: false,
        error: options.signal?.aborted ? "Cancelled." : "Did not run.",
        turns: 0,
        costUsd: 0,
        durationMs: 0,
      };
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  return {
    ok: succeeded > 0,
    total: results.length,
    succeeded,
    failed,
    totalCostUsd: Number(spentUsd.toFixed(6)),
    budgetExhausted,
    results,
  };
}
