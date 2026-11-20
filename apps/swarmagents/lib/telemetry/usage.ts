/**
 * usage.ts — aggregate usage/run.finished telemetry into per-run and per-day
 * totals (tokens + cost), with per-provider and per-model breakdowns.
 *
 * Source of truth is the durable per-run JSONL telemetry log written by the
 * TelemetryBus (see run-log.ts), so totals survive a server restart.
 *
 * Event shapes consumed (see lib/harness/types.ts and lib/runtime/manager.ts):
 * - `usage` — assistant-message usage or the final cumulative result usage;
 *   inputTokens/outputTokens are summed (same convention as
 *   lib/client/runTimeline.ts). cachedTokens folds cache reads + creations.
 * - `run.finished` — final costUsd / durationMs / numTurns for the run.
 * - `run.started` — model and serving provider for the run (the provider is
 *   the one the router actually selected, so runs without a failover are no
 *   longer reported as "unknown").
 * - `run.failover` (data.provider) — overrides the provider named on
 *   run.started when the run actually failed over.
 * - `run.created` (data.userId) — ownership, for per-user scoping.
 *
 * Day buckets are UTC calendar days keyed by the run's finish time (or
 * creation time while still running).
 */

import type { SequencedEvent } from "./bus";
import { getRunsDir } from "./paths";
import { listRunLogs, readRunEvents } from "./run-log";
import type { ProviderConfig } from "../providers/types";

export type RunUsageStatus = "queued" | "running" | "finished" | "error" | "cancelled";

/** Token + cost totals for one run. */
export interface RunUsage {
  runId: string;
  userId?: string;
  status: RunUsageStatus;
  /** Model reported by run.started, when present. */
  model?: string;
  /**
   * Provider that served the run, from run.started / run.failover events;
   * "unknown" only when telemetry never named one (e.g. host-env fallback).
   */
  provider: string;
  createdAt: number;
  finishedAt?: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Cost in USD, from run.finished; absent when the run never reported one. */
  costUsd?: number;
  /**
   * Cost in USD summed from `llm.call` telemetry (the gateway's per-attempt
   * cost estimates). When present it is the more precise figure and takes
   * precedence over run.finished costUsd in slice totals.
   */
  callCostUsd?: number;
  /**
   * Cost in USD of the output lenses applied to this run (see lib/lenses).
   * Kept apart from callCostUsd so a lens cost is added on top of the run's
   * own cost instead of replacing it.
   */
  lensCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

/** A summed slice of usage: one day, one provider, one model, or the grand total. */
export interface UsageSlice {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Sum of run.finished costUsd over runs that reported one. */
  costUsd: number;
  runs: number;
  /** Runs in this slice that reported a cost (costUsd covers only these). */
  runsWithCost: number;
}

/** One UTC calendar day of usage. */
export interface DayUsage extends UsageSlice {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  byProvider: Record<string, UsageSlice>;
  byModel: Record<string, UsageSlice>;
}

/** Daily budget status for one provider, derived from config + today's spend. */
export interface ProviderBudgetStatus {
  id: string;
  /** Configured daily USD budget; always present (unbudgeted providers are omitted). */
  budgetUsd: number;
  /** USD spent on this provider today, from telemetry run costs. */
  spentTodayUsd: number;
  remainingUsd: number;
  /** spentTodayUsd / budgetUsd; exceeds 1 on overspend. */
  fractionUsed: number;
}

export interface UsageReport {
  /** Days within the requested window, newest first. Empty days are omitted. */
  days: DayUsage[];
  /** Per-run totals within the window, newest first. */
  runs: RunUsage[];
  /**
   * Per-provider daily budget status, present when provider configs are
   * supplied (see ComputeUsageOptions.providers). Only providers with a
   * configured positive dailyBudgetUsd appear; empty otherwise.
   */
  budgets: ProviderBudgetStatus[];
  totals: UsageSlice;
}

export const UNKNOWN_PROVIDER = "unknown";
export const UNKNOWN_MODEL = "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function emptySlice(): UsageSlice {
  return { tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, runs: 0, runsWithCost: 0 };
}

function addRunToSlice(slice: UsageSlice, run: RunUsage): void {
  slice.tokensIn += run.tokensIn;
  slice.tokensOut += run.tokensOut;
  slice.tokensCached += run.tokensCached;
  // A lens cost is added on top of the run's own cost; the run's own cost
  // comes from the gateway calls when there are any, else from run.finished.
  const base = run.callCostUsd ?? run.costUsd;
  const lensCost = run.lensCostUsd ?? 0;
  if (base !== undefined || lensCost > 0) {
    slice.costUsd += (base ?? 0) + lensCost;
    slice.runsWithCost += 1;
  }
  slice.runs += 1;
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Fold one run's persisted events into its usage totals. */
export function aggregateRunUsage(runId: string, events: readonly SequencedEvent[]): RunUsage {
  const run: RunUsage = {
    runId,
    status: "running",
    provider: UNKNOWN_PROVIDER,
    createdAt: events[0]?.ts ?? 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
  };

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    // Harness events carry their fields at the top level; run.created carries
    // a data payload. Read both, as lib/runtime/run-store.ts does.
    const field = (name: string): unknown =>
      name in event ? (event as unknown as Record<string, unknown>)[name] : data[name];

    switch (event.type) {
      case "run.created":
        run.userId = str(data.userId) ?? run.userId;
        run.model = str(data.model) ?? run.model;
        if (typeof event.ts === "number") run.createdAt = event.ts;
        break;
      case "run.queued":
        // Waiting behind an active run: queued, not running. run.started
        // flips it back to running when the run actually starts.
        run.status = "queued";
        break;
      case "run.started":
        run.status = "running";
        run.model = str(field("model")) ?? run.model;
        // The router records the provider it actually selected; a later
        // failover event may still override it below.
        run.provider = str(field("provider")) ?? run.provider;
        break;
      case "usage":
        run.tokensIn += num(field("inputTokens")) ?? 0;
        run.tokensOut += num(field("outputTokens")) ?? 0;
        run.tokensCached += num(field("cachedTokens")) ?? 0;
        // A later llm event can fill a model gap left by run.started (the
        // harness attaches the generating model to usage events).
        run.model = str(field("model")) ?? run.model;
        break;
      case "run.failover":
        // The serving provider after a failover; the last one wins.
        run.provider = str(data.provider) ?? run.provider;
        run.model = str(data.model) ?? run.model;
        break;
      case "llm.call":
        // Gateway telemetry per provider attempt (see lib/runtime/llm-gateway.ts).
        // Only ok calls count toward the run cost; the serving provider is the
        // last ok attempt. Event data never contains secrets or prompts.
        if (data.source === "lens") {
          // Output lenses ride on the same bus (see lib/lenses/run.ts) but are
          // not part of the agent's own calls: their cost is kept apart so it
          // adds to the run's cost instead of replacing it, and the run keeps
          // the provider that served it.
          if (typeof data.costUsd === "number") {
            run.lensCostUsd = (run.lensCostUsd ?? 0) + data.costUsd;
          }
          break;
        }
        if (data.outcome === "ok") {
          run.provider = str(data.provider) ?? run.provider;
        }
        if (typeof data.costUsd === "number") {
          run.callCostUsd = (run.callCostUsd ?? 0) + data.costUsd;
        }
        break;
      case "run.finished":
        run.status = "finished";
        run.finishedAt = event.ts;
        run.costUsd = num(field("costUsd"));
        run.durationMs = num(field("durationMs"));
        run.numTurns = num(field("numTurns"));
        break;
      case "run.error":
        run.status = "error";
        run.finishedAt = event.ts;
        break;
      case "run.cancelled":
        run.status = "cancelled";
        run.finishedAt = event.ts;
        break;
      default:
        break;
    }
  }

  return run;
}

/**
 * Aggregate per-run totals into per-day totals plus a grand total.
 * `runs` may be in any order; days and runs in the report are newest first.
 */
export function aggregateUsage(runs: readonly RunUsage[]): UsageReport {
  const days = new Map<string, DayUsage>();
  const totals = emptySlice();
  const sorted = [...runs].sort(
    (a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt),
  );

  for (const run of sorted) {
    const date = dayKey(run.finishedAt ?? run.createdAt);
    let day = days.get(date);
    if (!day) {
      day = { date, ...emptySlice(), byProvider: {}, byModel: {} };
      days.set(date, day);
    }
    addRunToSlice(day, run);
    addRunToSlice(totals, run);

    const providerKey = run.provider || UNKNOWN_PROVIDER;
    const modelKey = run.model || UNKNOWN_MODEL;
    day.byProvider[providerKey] ??= emptySlice();
    day.byModel[modelKey] ??= emptySlice();
    addRunToSlice(day.byProvider[providerKey], run);
    addRunToSlice(day.byModel[modelKey], run);
  }

  return {
    days: [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
    runs: sorted,
    budgets: [],
    totals,
  };
}

/**
 * Map provider configs to daily budget status using telemetry spend. Only
 * providers with a positive dailyBudgetUsd appear. Pure and side-effect free.
 */
export function providerBudgetStatuses(
  providers: readonly ProviderConfig[],
  spentTodayByProvider: Readonly<Record<string, number>>,
): ProviderBudgetStatus[] {
  const statuses: ProviderBudgetStatus[] = [];
  for (const provider of providers) {
    const budgetUsd = provider.dailyBudgetUsd;
    if (budgetUsd === undefined || budgetUsd <= 0) continue;
    const spentTodayUsd = spentTodayByProvider[provider.id] ?? 0;
    statuses.push({
      id: provider.id,
      budgetUsd,
      spentTodayUsd,
      remainingUsd: Math.max(0, budgetUsd - spentTodayUsd),
      fractionUsed: spentTodayUsd / budgetUsd,
    });
  }
  return statuses;
}

function spentTodayByProvider(report: UsageReport): Record<string, number> {
  const today = report.days.find((d) => d.date === dayKey(Date.now()));
  const spent: Record<string, number> = {};
  if (today) {
    for (const [id, slice] of Object.entries(today.byProvider)) {
      spent[id] = slice.costUsd;
    }
  }
  return spent;
}

export interface ComputeUsageOptions {
  runsDir?: string | null;
  /** Only include runs owned by this user (from run.created userId). */
  userId?: string;
  /** Window in UTC days ending today; defaults to 30, capped at 90. */
  days?: number;
  /** Max per-run entries in the report; defaults to 20, capped at 200. */
  limit?: number;
  /** Provider configs; when supplied, the report carries per-provider budgets. */
  providers?: readonly ProviderConfig[];
}

/**
 * Build a usage report from the durable run logs on disk. Runs with no
 * events are skipped; a run with no usage events and no run.finished still
 * appears (zero tokens, no cost) so the meter never hides activity.
 */
export function computeUsage(options: ComputeUsageOptions = {}): UsageReport {
  const runsDir = options.runsDir === undefined ? getRunsDir() : options.runsDir;
  const daysWindow = Math.max(1, Math.min(options.days ?? 30, 90));
  const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
  if (!runsDir) return { days: [], runs: [], budgets: [], totals: emptySlice() };

  const cutoff = Date.now() - daysWindow * 24 * 60 * 60 * 1000;
  const runs: RunUsage[] = [];
  for (const info of listRunLogs(runsDir)) {
    const events = readRunEvents(info.runId, runsDir);
    if (events.length === 0) continue;
    const run = aggregateRunUsage(info.runId, events);
    if (options.userId && run.userId !== options.userId) continue;
    if ((run.finishedAt ?? run.createdAt) < cutoff) continue;
    runs.push(run);
  }

  const report = aggregateUsage(runs);
  const budgets =
    options.providers && options.providers.length > 0
      ? providerBudgetStatuses(options.providers, spentTodayByProvider(report))
      : [];
  return { ...report, runs: report.runs.slice(0, limit), budgets };
}
