/**
 * Per-metric colours for the codebase heatmap.
 *
 * The treemap can be sized and coloured by one of five metrics. Heat, churn,
 * complexity and touches share the cold-blue -> hot-amber scale the map
 * always used (bigger and hotter = more attention). Coverage inverts the
 * meaning: low coverage is hot amber/red, high coverage is cool green/blue,
 * because missing coverage is the hotspot.
 *
 * Tiles with no data for the active metric (today only coverage can be
 * missing: `coveragePct: null` means the repo has no coverage artifact) are
 * never rendered as zero or as cold — they get {@link NO_DATA_FILL} and the
 * caller hatches them, with a "no coverage data" note.
 */

import type { CodebaseHotspot } from "../../../lib/client/codebase";

export type HeatmapMetric = "heat" | "churn" | "complexity" | "coverage" | "touches";

export interface HeatmapMetricDef {
  id: HeatmapMetric;
  label: string;
  /** Heading shown above the treemap while this metric is active. */
  heading: string;
  /** One-line legend naming the active metric. */
  legend: string;
}

export const HEATMAP_METRICS: HeatmapMetricDef[] = [
  {
    id: "heat",
    label: "Heat",
    heading: "Treemap · churn × size × fan-in",
    legend: "Heat — churn × size × fan-in × touches. Bigger and hotter = needs attention first.",
  },
  {
    id: "churn",
    label: "Churn",
    heading: "Treemap · churn (90 days)",
    legend: "Churn — commits touching the file in the last 90 days. Bigger and hotter = churning fastest.",
  },
  {
    id: "complexity",
    label: "Complexity",
    heading: "Treemap · complexity",
    legend:
      "Complexity — bigger and hotter = harder to reason about. Falls back to churn when the map has no complexity yet.",
  },
  {
    id: "coverage",
    label: "Coverage",
    heading: "Treemap · coverage (low = hot)",
    legend:
      "Coverage — bigger, hotter tiles are the least-tested files. Grey hatched tiles have no coverage data.",
  },
  {
    id: "touches",
    label: "Touches",
    heading: "Treemap · agent touches",
    legend: "Touches — how often agents have edited the file. Bigger and hotter = edited most.",
  },
];

/** Clamp any value into the 0..1 range (non-finite values become 0). */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * The raw (unnormalised) value of `metric` for one hotspot, or `null` when
 * the map has no data for it.
 *
 * Complexity and coverage are optional on `CodebaseHotspot` (Worker A adds
 * them server-side): complexity falls back to churn — the closest available
 * signal — while coverage has no honest fallback, so it stays `null`.
 */
export function metricRawValue(hotspot: CodebaseHotspot, metric: HeatmapMetric): number | null {
  switch (metric) {
    case "heat":
      return hotspot.heat;
    case "churn":
      return hotspot.churn90d;
    case "complexity":
      return typeof hotspot.complexity === "number" && Number.isFinite(hotspot.complexity)
        ? hotspot.complexity
        : hotspot.churn90d;
    case "coverage":
      return typeof hotspot.coveragePct === "number" && Number.isFinite(hotspot.coveragePct)
        ? hotspot.coveragePct
        : null;
    case "touches":
      return hotspot.agentTouches;
  }
}

/**
 * Normalise a raw value against `max` (the largest raw value in the map, or
 * 100 for coverage, which is an absolute 0–100 scale). Clamped to 0..1.
 */
export function normalizeMetricValue(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return clamp01(value / max);
}

/** Fill for a tile with no data for the active metric — dimmed, never zero. */
export const NO_DATA_FILL = "rgba(148, 163, 184, 0.10)";

/**
 * The colour of one tile. `value` is normalised 0..1, or `null` when the map
 * has no data for the metric on this tile.
 */
export function heatmapColor(metric: HeatmapMetric, value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_DATA_FILL;
  const v = clamp01(value);
  if (metric === "coverage") {
    // Inverted: low coverage is the hotspot. Hotness 1 (0% covered) is red,
    // hotness 0 (100% covered) is cool green; amber sits in the middle.
    const hotness = 1 - v;
    const hue = 160 - hotness * 160;
    return `hsl(${hue.toFixed(0)} 80% ${(26 + hotness * 24).toFixed(0)}% / ${(0.22 + hotness * 0.6).toFixed(2)})`;
  }
  // Cold blue -> hot amber, the scale the treemap always used.
  const hue = 200 - v * 190;
  return `hsl(${hue.toFixed(0)} 80% ${(26 + v * 24).toFixed(0)}% / ${(0.22 + v * 0.6).toFixed(2)})`;
}

/** Coverage at or below this percent counts as low (primary "Write missing tests"). */
export const LOW_COVERAGE_PCT = 50;

/**
 * Whether "Write missing tests" should be the primary strike action: the
 * file's coverage is low or unknown (no coverage artifact in the repo).
 */
export function isLowCoverage(hotspot: CodebaseHotspot, threshold = LOW_COVERAGE_PCT): boolean {
  if (typeof hotspot.coveragePct !== "number" || !Number.isFinite(hotspot.coveragePct)) return true;
  return hotspot.coveragePct < threshold;
}
