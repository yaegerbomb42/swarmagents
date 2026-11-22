/**
 * run-token-accounting.ts — per-run token accounting for the run report.
 *
 * Folds a run's persisted telemetry into a per-provider/model breakdown:
 * how many LLM calls each model served, how many tokens they moved, and
 * what they cost. Two event sources, kept apart because they measure
 * different things:
 *
 *   - `llm.call` — the gateway's per-attempt record (provider, model,
 *     tokens when the response reported usage, costUsd stamped at emit
 *     time by lib/providers/pricing.ts — the provider-reported amount
 *     when the response carried one (costReported), else an estimate;
 *     null = price unknown). This is the accounting of record for BYOK
 *     gateway runs.
 *   - `usage` — the harness/CLI stream's own usage snapshots (input,
 *     output, cached). Summed the same way lib/telemetry/usage.ts sums
 *     them, so the report and the usage meter never disagree.
 *
 * Prices are never invented here: a call whose costUsd is null counts
 * toward `unknownCostCalls` and contributes nothing to the cost sum; a
 * model with no priced calls reports `costUsd: undefined` ("unknown" in
 * the UI), not $0. Lens calls (data.source === "lens") are excluded —
 * they are output post-processing, accounted apart in usage.ts.
 *
 * Pure: events in, accounting out. Returns undefined when the run has no
 * llm.call and no usage events, so reports for runs without telemetry
 * stay exactly as they were.
 */

import type { SequencedEvent } from "./bus";
import type {
  ModelTokenAccounting,
  RunTokenAccounting,
} from "../runtime/run-report-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface ModelAccumulator {
  provider: string;
  model: string;
  calls: number;
  okCalls: number;
  inputTokens: number;
  outputTokens: number;
  costSum: number;
  pricedCalls: number;
  unknownCostCalls: number;
  reportedCostCalls: number;
}

/** Fold one run's persisted events into its token accounting. */
export function aggregateRunTokenAccounting(
  events: readonly SequencedEvent[],
): RunTokenAccounting | undefined {
  const byKey = new Map<string, ModelAccumulator>();
  let harnessIn = 0;
  let harnessOut = 0;
  let harnessCached = 0;
  let sawUsage = false;

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    // Harness events carry their fields at the top level; llm.call carries
    // a data payload. Read both, as lib/telemetry/usage.ts does.
    const field = (name: string): unknown =>
      name in event ? (event as unknown as Record<string, unknown>)[name] : data[name];

    if (event.type === "usage") {
      sawUsage = true;
      harnessIn += num(field("inputTokens")) ?? 0;
      harnessOut += num(field("outputTokens")) ?? 0;
      harnessCached += num(field("cachedTokens")) ?? 0;
      continue;
    }

    if (event.type !== "llm.call") continue;
    if (data.source === "lens") continue;

    const provider = str(data.provider) ?? "unknown";
    const model = str(data.model) ?? "unknown";
    const key = `${provider}\u0000${model}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        provider,
        model,
        calls: 0,
        okCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costSum: 0,
        pricedCalls: 0,
        unknownCostCalls: 0,
        reportedCostCalls: 0,
      };
      byKey.set(key, acc);
    }
    acc.calls += 1;
    if (data.outcome === "ok") acc.okCalls += 1;
    // Tokens count whenever the attempt reported usage, ok or not — the
    // provider moved them either way. Failed attempts rarely report any.
    acc.inputTokens += num(data.inputTokens) ?? 0;
    acc.outputTokens += num(data.outputTokens) ?? 0;
    if (typeof data.costUsd === "number" && Number.isFinite(data.costUsd)) {
      acc.costSum += data.costUsd;
      acc.pricedCalls += 1;
      if (data.costReported === true) acc.reportedCostCalls += 1;
    } else {
      acc.unknownCostCalls += 1;
    }
  }

  if (byKey.size === 0 && !sawUsage) return undefined;

  const byModel: ModelTokenAccounting[] = [...byKey.values()]
    .map((acc) => ({
      provider: acc.provider,
      model: acc.model,
      calls: acc.calls,
      okCalls: acc.okCalls,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      ...(acc.pricedCalls > 0 ? { costUsd: acc.costSum } : {}),
      unknownCostCalls: acc.unknownCostCalls,
      reportedCostCalls: acc.reportedCostCalls,
    }))
    // Busiest model first; ties broken by name so the order is stable.
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

  const totals = {
    calls: byModel.reduce((sum, m) => sum + m.calls, 0),
    okCalls: byModel.reduce((sum, m) => sum + m.okCalls, 0),
    inputTokens: byModel.reduce((sum, m) => sum + m.inputTokens, 0),
    outputTokens: byModel.reduce((sum, m) => sum + m.outputTokens, 0),
    unknownCostCalls: byModel.reduce((sum, m) => sum + m.unknownCostCalls, 0),
    reportedCostCalls: byModel.reduce((sum, m) => sum + m.reportedCostCalls, 0),
  };
  const anyPriced = byModel.some((m) => m.costUsd !== undefined);

  return {
    byModel,
    totals: {
      ...totals,
      ...(anyPriced
        ? { costUsd: byModel.reduce((sum, m) => sum + (m.costUsd ?? 0), 0) }
        : {}),
    },
    ...(sawUsage
      ? {
          harness: {
            inputTokens: harnessIn,
            outputTokens: harnessOut,
            cachedTokens: harnessCached,
          },
        }
      : {}),
  };
}
