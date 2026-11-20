/**
 * Run comparison and diff engine: compares two completed RunReport objects
 * across outcome status, cost, duration, routing, artifacts, and blockers.
 * Kept in lib/runtime so it can be imported by unit tests and routes without
 * violating Next.js App Router route module export conventions.
 */

import type { RunReport } from "./run-report-types";

export type OutcomeVerdict = "improved" | "regressed" | "both-succeeded" | "both-failed";

export interface MetricDelta {
  base: number;
  target: number;
  delta: number;
  pctChange: number | null;
  direction: "decreased" | "increased" | "unchanged";
}

export interface RunSideSummary {
  runId: string;
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
  costUsd: number | null;
  durationMs: number | null;
  model: string | null;
  providers: string[];
  stepCount: number;
  artifactCount: number;
  blockerCount: number;
  shotCount: number;
}

export interface SharedArtifactDiff {
  rel: string;
  path: string;
  baseChange: string;
  targetChange: string;
  baseSize: number;
  targetSize: number;
  sizeDeltaBytes: number;
}

export interface ArtifactSummary {
  rel: string;
  path: string;
  change: string;
  size: number;
}

export interface RunComparison {
  base: RunSideSummary;
  target: RunSideSummary;
  outcome: OutcomeVerdict;
  cost: MetricDelta | null;
  duration: MetricDelta | null;
  steps: MetricDelta;
  routing: {
    modelChanged: boolean;
    baseModel: string | null;
    targetModel: string | null;
    providersAdded: string[];
    providersRemoved: string[];
  };
  artifacts: {
    onlyInBase: ArtifactSummary[];
    onlyInTarget: ArtifactSummary[];
    inBoth: SharedArtifactDiff[];
  };
  blockers: {
    resolved: string[];
    introduced: string[];
    persisting: string[];
  };
  highlights: string[];
  digest: string;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function computeDelta(base: number | null, target: number | null): MetricDelta | null {
  if (base === null || target === null) return null;
  const delta = Number((target - base).toFixed(6));
  const pctChange = base !== 0 ? Number((((target - base) / base) * 100).toFixed(2)) : null;
  const direction = delta === 0 ? "unchanged" : delta < 0 ? "decreased" : "increased";
  return { base, target, delta, pctChange, direction };
}

function summarizeSide(report: RunReport): RunSideSummary {
  const providers = Array.isArray(report.meta?.providers)
    ? report.meta.providers.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  const model = typeof report.meta?.model === "string" && report.meta.model.trim() ? report.meta.model.trim() : null;
  const startedAt = finiteNumber((report as unknown as { startedAt?: unknown }).startedAt) ?? finiteNumber(report.createdAt);
  return {
    runId: report.runId,
    status: typeof report.status === "string" ? report.status : "unknown",
    startedAt,
    finishedAt: finiteNumber(report.finishedAt),
    costUsd: finiteNumber(report.meta?.costUsd),
    durationMs: finiteNumber(report.meta?.durationMs),
    model,
    providers,
    stepCount: Array.isArray(report.steps) ? report.steps.length : 0,
    artifactCount: Array.isArray(report.artifacts) ? report.artifacts.length : 0,
    blockerCount: Array.isArray(report.couldNotDo) ? report.couldNotDo.length : 0,
    shotCount: Array.isArray(report.shots) ? report.shots.length : 0,
  };
}

function classifyOutcome(baseStatus: string, targetStatus: string): OutcomeVerdict {
  const baseOk = baseStatus === "finished";
  const targetOk = targetStatus === "finished";
  if (!baseOk && targetOk) return "improved";
  if (baseOk && !targetOk) return "regressed";
  if (baseOk && targetOk) return "both-succeeded";
  return "both-failed";
}

function diffArtifacts(base: RunReport, target: RunReport): RunComparison["artifacts"] {
  const baseMap = new Map<string, ArtifactSummary>();
  for (const item of Array.isArray(base.artifacts) ? base.artifacts : []) {
    const key = item.rel || item.path;
    if (!key) continue;
    baseMap.set(key, { rel: item.rel || key, path: item.path, change: item.change, size: item.size });
  }

  const targetMap = new Map<string, ArtifactSummary>();
  for (const item of Array.isArray(target.artifacts) ? target.artifacts : []) {
    const key = item.rel || item.path;
    if (!key) continue;
    targetMap.set(key, { rel: item.rel || key, path: item.path, change: item.change, size: item.size });
  }

  const onlyInBase: ArtifactSummary[] = [];
  const onlyInTarget: ArtifactSummary[] = [];
  const inBoth: SharedArtifactDiff[] = [];

  for (const [key, b] of baseMap) {
    const t = targetMap.get(key);
    if (!t) {
      onlyInBase.push(b);
    } else {
      inBoth.push({
        rel: b.rel,
        path: t.path || b.path,
        baseChange: b.change,
        targetChange: t.change,
        baseSize: b.size,
        targetSize: t.size,
        sizeDeltaBytes: t.size - b.size,
      });
    }
  }

  for (const [key, t] of targetMap) {
    if (!baseMap.has(key)) {
      onlyInTarget.push(t);
    }
  }

  return { onlyInBase, onlyInTarget, inBoth };
}

function diffBlockers(base: RunReport, target: RunReport): RunComparison["blockers"] {
  const normalize = (list: unknown): string[] =>
    Array.isArray(list)
      ? Array.from(
          new Set(
            list
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        )
      : [];

  const baseList = normalize(base.couldNotDo);
  const targetList = normalize(target.couldNotDo);
  const baseSet = new Set(baseList);
  const targetSet = new Set(targetList);

  return {
    resolved: baseList.filter((item) => !targetSet.has(item)),
    introduced: targetList.filter((item) => !baseSet.has(item)),
    persisting: targetList.filter((item) => baseSet.has(item)),
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function compareRunReports(baseReport: RunReport, targetReport: RunReport): RunComparison {
  const base = summarizeSide(baseReport);
  const target = summarizeSide(targetReport);
  const outcome = classifyOutcome(base.status, target.status);
  const cost = computeDelta(base.costUsd, target.costUsd);
  const duration = computeDelta(base.durationMs, target.durationMs);
  const steps = computeDelta(base.stepCount, target.stepCount)!;

  const baseProviders = new Set(base.providers);
  const targetProviders = new Set(target.providers);
  const routing = {
    modelChanged: base.model !== target.model,
    baseModel: base.model,
    targetModel: target.model,
    providersAdded: target.providers.filter((p) => !baseProviders.has(p)),
    providersRemoved: base.providers.filter((p) => !targetProviders.has(p)),
  };

  const artifacts = diffArtifacts(baseReport, targetReport);
  const blockers = diffBlockers(baseReport, targetReport);

  const highlights: string[] = [];
  if (outcome === "improved") {
    highlights.push(`Target run succeeded (${target.status}) whereas base run ended as ${base.status}.`);
  } else if (outcome === "regressed") {
    highlights.push(`Target run regressed to ${target.status} from ${base.status}.`);
  } else {
    highlights.push(`Both runs ended with status "${target.status}".`);
  }

  if (cost && cost.direction !== "unchanged") {
    const pct = cost.pctChange !== null ? ` (${cost.pctChange > 0 ? "+" : ""}${cost.pctChange}%)` : "";
    highlights.push(
      `Cost ${cost.direction}: ${formatUsd(cost.base)} -> ${formatUsd(cost.target)}${pct}.`,
    );
  }

  if (duration && duration.direction !== "unchanged") {
    const pct = duration.pctChange !== null ? ` (${duration.pctChange > 0 ? "+" : ""}${duration.pctChange}%)` : "";
    highlights.push(
      `Duration ${duration.direction}: ${duration.base}ms -> ${duration.target}ms${pct}.`,
    );
  }

  if (routing.modelChanged && (base.model || target.model)) {
    highlights.push(`Model switched from ${base.model ?? "unknown"} to ${target.model ?? "unknown"}.`);
  }

  if (blockers.resolved.length > 0 || blockers.introduced.length > 0) {
    highlights.push(
      `Blockers: ${blockers.resolved.length} resolved, ${blockers.introduced.length} introduced.`,
    );
  }

  const totalTouched = artifacts.onlyInBase.length + artifacts.onlyInTarget.length + artifacts.inBoth.length;
  if (totalTouched > 0) {
    highlights.push(
      `Artifacts: ${artifacts.inBoth.length} shared, ${artifacts.onlyInTarget.length} new in target, ${artifacts.onlyInBase.length} only in base.`,
    );
  }

  const modelLabel =
    routing.modelChanged && base.model && target.model
      ? ` (${base.model} -> ${target.model})`
      : target.model
        ? ` (${target.model})`
        : "";
  const costLabel = cost ? ` | cost ${formatUsd(cost.base)} -> ${formatUsd(cost.target)}` : "";
  const durationLabel = duration ? ` | ${duration.base}ms -> ${duration.target}ms` : "";
  const digest = `Run comparison ${base.runId} -> ${target.runId}${modelLabel}: ${outcome}${costLabel}${durationLabel}.`;

  return {
    base,
    target,
    outcome,
    cost,
    duration,
    steps,
    routing,
    artifacts,
    blockers,
    highlights,
    digest,
  };
}
