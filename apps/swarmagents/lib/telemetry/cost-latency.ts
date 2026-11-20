/**
 * cost-latency.ts — per-run cost and latency aggregation from a recorded
 * telemetry event log.
 *
 * The durable per-run JSONL log (lib/telemetry/run-log.ts) is the source of
 * truth for what a run spent and how long it waited. This module folds that
 * log into the numbers the cost dashboard shows:
 *
 *   - dollars per run and per provider (from `llm.call` cost estimates, with
 *     the run's own reported `run.finished` cost as the fallback),
 *   - tokens in / out / cached (from the harness `usage` events),
 *   - a latency waterfall per provider attempt: queued -> first token ->
 *     complete,
 *   - the model switch timeline (which provider/model served which call).
 *
 * Everything here is pure: it takes the recorded events and returns a report.
 * That keeps the aggregation unit-testable against a recorded log and lets the
 * same numbers be served over the API and re-derived in the browser.
 *
 * Event shapes consumed (see lib/runtime/llm-gateway.ts and
 * lib/harness/runner.ts):
 *   - `llm.call`: provider, model, attempt, outcome, costUsd, inputTokens,
 *     outputTokens, latencyMs, queuedMs, ttftMs. The gateway carries these in
 *     the event's `data` payload; the fake provider carries them flat.
 *   - `usage`: inputTokens, outputTokens, cachedTokens (harness side).
 *   - `run.started`: model and the provider that serves the run.
 *   - `run.finished`: costUsd, durationMs, numTurns.
 */

/**
 * A telemetry event as recorded in a run's log. Deliberately structural: the
 * same shape is produced by the durable log (lib/telemetry/bus.ts) and by the
 * browser's SSE stream, so one aggregator serves both.
 */
export interface CostEvent {
  type: string;
  seq: number;
  ts: number;
  data?: unknown;
}

/** Where a run's dollar total came from. */
export type CostSource = "llm_calls" | "run_finished" | "none";

/** One provider attempt: the unit of the latency waterfall. */
export interface CallCostEntry {
  /** Telemetry sequence number of the attempt. */
  seq: number;
  /** Epoch ms the attempt was reported. */
  ts: number;
  provider: string;
  model: string;
  /** 1-based attempt number within the proxied request. */
  attempt: number;
  /** "ok" or the failover reason (401/402/429/5xx/timeout, ...). */
  outcome: string;
  /** Estimated USD for this attempt; null when no price is known. */
  costUsd: number | null;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Milliseconds the attempt waited before the provider started serving it:
   * the gap since the previous attempt ended (or since the request arrived
   * for the first attempt). This is the "queued" segment of the waterfall.
   */
  queuedMs: number;
  /** Milliseconds to the first token; absent when it was not observed. */
  ttftMs?: number;
  /** Total attempt duration ("complete" segment of the waterfall). */
  latencyMs: number;
}

/** Per-provider rollup of a run's spend. */
export interface ProviderCost {
  provider: string;
  /** Attempts made against this provider (ok and failed). */
  calls: number;
  /** Attempts that succeeded. */
  okCalls: number;
  /** Summed USD spent on this provider (failed attempts cost nothing). */
  costUsd: number;
  /** Tokens reported by this provider's successful attempts. */
  tokensIn: number;
  tokensOut: number;
  /** Sum of the attempt durations. */
  totalLatencyMs: number;
  /** Mean attempt duration (0 when there were no attempts). */
  avgLatencyMs: number;
  /** Mean time to first token over attempts that reported one. */
  avgTtftMs?: number;
}

/** A change of the provider/model that served a run. */
export interface ModelSwitch {
  /** Epoch ms of the switch. */
  ts: number;
  /** Provider that served the previous call. */
  fromProvider: string;
  /** Model that served the previous call. */
  fromModel: string;
  /** Provider that served this call. */
  toProvider: string;
  /** Model that served this call. */
  toModel: string;
  /** Outcome of the attempt that introduced the switch. */
  outcome: string;
}

/** Everything the cost dashboard shows for one run. */
export interface RunCostLatency {
  runId: string;
  /** Owner of the run, when the log records one. */
  userId?: string;
  /**
   * Provider that served the run (from run.started / run.failover, or the last
   * successful `llm.call`). "unknown" when telemetry never named one.
   */
  provider: string;
  /** Total estimated USD spent by the run. */
  costUsd: number;
  /** Which telemetry the total was derived from. */
  costSource: CostSource;
  /** Tokens consumed (harness `usage` events). */
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Provider attempts, oldest first. */
  calls: CallCostEntry[];
  /** Successful attempts whose cost the provider priced. */
  pricedCalls: number;
  /** Per-provider rollup, most expensive first. */
  byProvider: ProviderCost[];
  /** Model/provider switches during the run, oldest first. */
  modelSwitches: ModelSwitch[];
  /** Sum of all attempt durations. */
  totalLatencyMs: number;
  /** Mean attempt duration over all attempts. */
  avgLatencyMs: number;
  /** Epoch ms of the first provider attempt. */
  firstCallAt?: number;
  /** Epoch ms of the last provider attempt. */
  lastCallAt?: number;
  /** Run duration reported by the harness. */
  durationMs?: number;
  /** Turns reported by the harness. */
  numTurns?: number;
  /** Model the run started with. */
  model?: string;
}

/** Budget levels a run's projected cost can be in. */
export type BudgetStatus = "uncapped" | "ok" | "warn" | "exceeded";

/** Fraction of the per-run budget at which a warning is raised. */
export const BUDGET_WARN_FRACTION = 0.8;

/** A run's spend measured against its per-run budget. */
export interface BudgetProjection {
  /** The per-run budget in USD; null when the user set no cap. */
  limitUsd: number | null;
  /** USD already spent by the run. */
  spentUsd: number;
  /** USD spent plus the expected cost of the next provider call. */
  projectedUsd: number;
  /** projectedUsd / limitUsd; null when there is no usable cap. */
  fraction: number | null;
  /** Budget level of the projection. */
  status: BudgetStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read a field from an event. Gateway events (`llm.call`) carry their payload
 * in `data`; harness events (`usage`, `run.finished`) carry it at the top
 * level. Both are accepted.
 */
function field(event: CostEvent, name: string): unknown {
  const flat = (event as unknown as Record<string, unknown>)[name];
  if (flat !== undefined) return flat;
  const data = isRecord(event.data) ? event.data : undefined;
  return data ? data[name] : undefined;
}

/**
 * Fold a run's recorded events into its cost and latency report.
 *
 * Failed provider attempts never add cost; the cost of a run is the sum of
 * its successful attempts, and the run's own reported cost is used when no
 * provider reported a price.
 */
export function aggregateRunCostLatency(
  runId: string,
  events: readonly CostEvent[],
): RunCostLatency {
  const report: RunCostLatency = {
    runId,
    provider: "unknown",
    costUsd: 0,
    costSource: "none",
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    calls: [],
    pricedCalls: 0,
    byProvider: [],
    modelSwitches: [],
    totalLatencyMs: 0,
    avgLatencyMs: 0,
  };

  const providers = new Map<string, ProviderCost>();
  let callCost = 0;
  let pricedCalls = 0;
  let reportedCost: number | undefined;
  let previousServing: { provider: string; model: string } | undefined;
  /** End of the previous attempt; the next attempt's queue time starts here. */
  let previousEnd: number | undefined;

  for (const event of events) {
    switch (event.type) {
      case "run.created": {
        const data = isRecord(event.data) ? event.data : {};
        report.userId = str(data.userId) ?? report.userId;
        report.model = str(data.model) ?? report.model;
        break;
      }
      case "run.started": {
        report.model = str(field(event, "model")) ?? report.model;
        report.provider = str(field(event, "provider")) ?? report.provider;
        break;
      }
      case "run.failover": {
        // The provider that served the run after a failover; the last one wins.
        report.provider = str(field(event, "provider")) ?? report.provider;
        report.model = str(field(event, "model")) ?? report.model;
        break;
      }
      case "usage": {
        report.tokensIn += num(field(event, "inputTokens")) ?? 0;
        report.tokensOut += num(field(event, "outputTokens")) ?? 0;
        report.tokensCached += num(field(event, "cachedTokens")) ?? 0;
        break;
      }
      case "run.finished": {
        reportedCost = num(field(event, "costUsd"));
        report.durationMs = num(field(event, "durationMs"));
        report.numTurns = num(field(event, "numTurns"));
        break;
      }
      case "llm.call": {
        const provider = str(field(event, "provider")) ?? "unknown";
        const model = str(field(event, "model")) ?? "unknown";
        const outcome = str(field(event, "outcome")) ?? "unknown";
        const latencyMs = num(field(event, "latencyMs")) ?? 0;
        const ttftMs = num(field(event, "ttftMs"));
        const inputTokens = num(field(event, "inputTokens"));
        const outputTokens = num(field(event, "outputTokens"));
        const costUsd = num(field(event, "costUsd")) ?? null;
        const startedAt = event.ts - latencyMs;
        const queuedMs = num(field(event, "queuedMs")) ?? Math.max(0, startedAt - (previousEnd ?? startedAt));

        const entry: CallCostEntry = {
          seq: event.seq,
          ts: event.ts,
          provider,
          model,
          attempt: num(field(event, "attempt")) ?? 1,
          outcome,
          costUsd,
          queuedMs,
          latencyMs,
          ...(ttftMs !== undefined ? { ttftMs } : {}),
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        };
        report.calls.push(entry);
        report.totalLatencyMs += latencyMs;
        if (report.firstCallAt === undefined) report.firstCallAt = event.ts;
        report.lastCallAt = event.ts;
        previousEnd = event.ts;

        let roll = providers.get(provider);
        if (!roll) {
          roll = {
            provider,
            calls: 0,
            okCalls: 0,
            costUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            totalLatencyMs: 0,
            avgLatencyMs: 0,
          };
          providers.set(provider, roll);
        }
        roll.calls += 1;
        roll.totalLatencyMs += latencyMs;

        if (outcome === "ok") {
          roll.okCalls += 1;
          report.provider = provider;
          if (costUsd !== null) {
            roll.costUsd += costUsd;
            callCost += costUsd;
            pricedCalls += 1;
          }
          roll.tokensIn += inputTokens ?? 0;
          roll.tokensOut += outputTokens ?? 0;
          if (
            previousServing &&
            (previousServing.provider !== provider || previousServing.model !== model)
          ) {
            report.modelSwitches.push({
              ts: event.ts,
              fromProvider: previousServing.provider,
              fromModel: previousServing.model,
              toProvider: provider,
              toModel: model,
              outcome,
            });
          }
          previousServing = { provider, model };
        }
        break;
      }
      default:
        break;
    }
  }

  if (pricedCalls > 0) {
    report.costUsd = callCost;
    report.costSource = "llm_calls";
    report.pricedCalls = pricedCalls;
  } else if (reportedCost !== undefined) {
    report.costUsd = reportedCost;
    report.costSource = "run_finished";
    // No provider priced the run's calls (the harness reported a total
    // instead). Attribute it to the provider that served the run so the
    // per-provider breakdown still shows where the money went.
    const provider = report.provider;
    if (provider !== "unknown") {
      const roll = providers.get(provider) ?? {
        provider,
        calls: 0,
        okCalls: 0,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
      };
      roll.costUsd += reportedCost;
      providers.set(provider, roll);
    }
  }

  report.byProvider = [...providers.values()]
    .map((roll) => {
      const ttfts = report.calls
        .filter((c) => c.provider === roll.provider && c.ttftMs !== undefined)
        .map((c) => c.ttftMs as number);
      return {
        ...roll,
        avgLatencyMs: roll.calls > 0 ? roll.totalLatencyMs / roll.calls : 0,
        ...(ttfts.length > 0
          ? { avgTtftMs: ttfts.reduce((sum, ms) => sum + ms, 0) / ttfts.length }
          : {}),
      };
    })
    .sort(
      (a, b) => b.costUsd - a.costUsd || b.calls - a.calls || a.provider.localeCompare(b.provider),
    );

  report.avgLatencyMs =
    report.calls.length > 0 ? report.totalLatencyMs / report.calls.length : 0;

  return report;
}

/**
 * Expected cost of one more provider call for a run: the mean cost of its
 * successful, priced attempts. Zero when the run has not spent anything yet
 * (or no price is known).
 */
export function expectedNextCallUsd(report: RunCostLatency): number {
  const priced = report.calls.filter((c) => c.outcome === "ok" && c.costUsd !== null);
  if (priced.length === 0) return 0;
  const sum = priced.reduce((total, c) => total + (c.costUsd as number), 0);
  return sum / priced.length;
}

/**
 * Project a run's cost against its per-run budget.
 *
 * The projection is what the run has spent plus the expected cost of its next
 * provider call: crossing 80% of the budget warns, reaching 100% of it stops
 * the run until the user says to continue.
 *
 * A cap of zero means "no paid spend at all" (the router refuses paid
 * providers outright), so any spend at all is over budget.
 */
export function projectRunBudget(args: {
  spentUsd: number;
  limitUsd: number | null;
  expectedNextCallUsd?: number;
}): BudgetProjection {
  const { spentUsd } = args;
  const limitUsd = args.limitUsd;
  const projectedUsd = spentUsd + Math.max(0, args.expectedNextCallUsd ?? 0);
  if (limitUsd === null || !Number.isFinite(limitUsd) || limitUsd < 0) {
    return { limitUsd: null, spentUsd, projectedUsd, fraction: null, status: "uncapped" };
  }
  if (limitUsd === 0) {
    const over = projectedUsd > 0;
    return {
      limitUsd,
      spentUsd,
      projectedUsd,
      fraction: over ? 1 : 0,
      status: over ? "exceeded" : "ok",
    };
  }
  const fraction = projectedUsd / limitUsd;
  const status: BudgetStatus =
    projectedUsd >= limitUsd ? "exceeded" : fraction >= BUDGET_WARN_FRACTION ? "warn" : "ok";
  return { limitUsd, spentUsd, projectedUsd, fraction, status };
}
