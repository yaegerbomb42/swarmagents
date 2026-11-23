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

import fs from "node:fs";
import type { SequencedEvent } from "./bus";
import {
  readLlmCall,
  readRunCreated,
  readRunFailover,
  readRunStarted,
  readTerminalEvent,
  readUsage,
} from "./events";
import { getRunsDir } from "./paths";
import { listRunLogs, readRunEvents } from "./run-log";
import type { ProviderConfig } from "../providers/types";

/**
 * Bounded LRU of per-run folded usage, validated by the newest log file's
 * (mtimeMs, size). Rotated segments are immutable once written and new
 * events only ever land in the newest file (the one listRunLogs returns),
 * so a matching (mtimeMs, size) means the run's events are unchanged.
 * This keeps repeated GET /api/usage calls from synchronously re-reading
 * and re-parsing every run log on disk.
 */
const MAX_USAGE_CACHE_ENTRIES = 1024;

interface CachedRunUsage {
  mtimeMs: number;
  size: number;
  usage: RunUsage;
}

const usageCache = new Map<string, CachedRunUsage>();

export function clearUsageCacheForTesting(): void {
  usageCache.clear();
}

function getCachedRunUsage(file: string, runId: string, runsDir: string): RunUsage | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    usageCache.delete(file);
    return null;
  }
  const cached = usageCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Refresh LRU recency.
    usageCache.delete(file);
    usageCache.set(file, cached);
    return cached.usage;
  }
  const events = readRunEvents(runId, runsDir);
  if (events.length === 0) return null;
  const usage = aggregateRunUsage(runId, events);
  if (usageCache.size >= MAX_USAGE_CACHE_ENTRIES) {
    const oldestKey = usageCache.keys().next().value;
    if (oldestKey !== undefined) usageCache.delete(oldestKey);
  }
  usageCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
  return usage;
}

export type RunUsageStatus = "queued" | "running" | "paused" | "finished" | "error" | "cancelled";

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
  if (!Number.isFinite(ts) || ts <= 0) return "1970-01-01";
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return "1970-01-01";
  }
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

  // Field reading and event normalization live in ./events.ts, shared with
  // cost-latency.ts so the two meters cannot drift apart again.
  for (const event of events) {
    switch (event.type) {
      case "run.created": {
        const created = readRunCreated(event);
        run.userId = created.userId ?? run.userId;
        run.model = created.model ?? run.model;
        if (typeof event.ts === "number") run.createdAt = event.ts;
        break;
      }
      case "run.queued":
        // Waiting behind an active run: queued, not running. run.started
        // flips it back to running when the run actually starts.
        run.status = "queued";
        break;
      case "run.paused":
        run.status = "paused";
        break;
      case "run.started": {
        const started = readRunStarted(event);
        run.status = "running";
        run.model = started.model ?? run.model;
        // The router records the provider it actually selected; a later
        // failover event may still override it below.
        run.provider = started.provider ?? run.provider;
        break;
      }
      case "usage": {
        const usage = readUsage(event);
        run.tokensIn += usage.inputTokens;
        run.tokensOut += usage.outputTokens;
        run.tokensCached += usage.cachedTokens;
        // A later llm event can fill a model gap left by run.started (the
        // harness attaches the generating model to usage events).
        run.model = usage.model ?? run.model;
        break;
      }
      case "run.failover": {
        const failover = readRunFailover(event);
        // The serving provider after a failover; the last one wins.
        run.provider = failover.provider ?? run.provider;
        run.model = failover.model ?? run.model;
        break;
      }
      case "llm.call": {
        // Gateway telemetry per provider attempt (see lib/runtime/llm-gateway.ts).
        // Only ok calls count toward the run cost; the serving provider is the
        // last ok attempt. Event data never contains secrets or prompts.
        const call = readLlmCall(event);
        if (call.source === "lens") {
          // Output lenses ride on the same bus (see lib/lenses/run.ts) but are
          // not part of the agent's own calls: their cost is kept apart so it
          // adds to the run's cost instead of replacing it, and the run keeps
          // the provider that served it. Only ok lens calls count — a failed
          // lens call spent nothing the meter can price.
          if (call.outcome === "ok" && call.costUsd !== null) {
            run.lensCostUsd = (run.lensCostUsd ?? 0) + call.costUsd;
          }
          break;
        }
        if (call.outcome === "ok") {
          run.provider = call.provider ?? run.provider;
          if (call.costUsd !== null) {
            run.callCostUsd = (run.callCostUsd ?? 0) + call.costUsd;
          }
        }
        break;
      }
      case "run.finished": {
        const terminal = readTerminalEvent(event);
        run.status = "finished";
        run.finishedAt = event.ts;
        run.costUsd = terminal?.costUsd;
        run.durationMs = terminal?.durationMs;
        run.numTurns = terminal?.numTurns;
        break;
      }
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
  const rawDays = options.days !== undefined && Number.isFinite(options.days) ? options.days : 30;
  const rawLimit = options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : 20;
  const daysWindow = Math.max(1, Math.min(rawDays, 90));
  const limit = Math.max(1, Math.min(rawLimit, 200));
  if (!runsDir) return { days: [], runs: [], budgets: [], totals: emptySlice() };

  const cutoff = Date.now() - daysWindow * 24 * 60 * 60 * 1000;
  const runs: RunUsage[] = [];
  for (const info of listRunLogs(runsDir)) {
    // Fast path: a log untouched since before the window cannot hold an
    // event inside it, so skip the read entirely.
    if (info.mtimeMs < cutoff) continue;
    const run = getCachedRunUsage(info.file, info.runId, runsDir);
    if (!run) continue;
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
