/**
 * Ranking rules for the codebase map.
 *
 * Two rankings come out of a scan:
 *
 *   - the heatmap: churn (90d) x size x fan-in x the files this account's
 *     agent touched before. It answers "where is the risk?".
 *   - the key files: pure import fan-in. It answers "what is load-bearing?".
 */

import { HEAT_WEIGHTS } from "./rules";
import type { CodebaseHeatmapEntry } from "./types";

export interface RankInput {
  path: string;
  bytes: number;
  fanIn: number;
  churn90d: number;
  agentTouches: number;
  /** Branch-count complexity; carried through to the heatmap entry. */
  complexity?: number;
  /** Lines covered, 0..100; null when the repository has no coverage for this file. */
  coveragePct?: number | null;
}

/** Scale a list of raw values into 0..1 against the largest value. */
function normalize(values: number[]): (value: number) => number {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  if (max <= 0) return () => 0;
  return (value) => (value > 0 ? value / max : 0);
}

/**
 * Rank files by heat. Ties break on fan-in, then churn, then path so the
 * order is stable across rebuilds (a rebuilt map must not reshuffle the UI).
 */
export function rankHeatmap(inputs: RankInput[], limit = 200): CodebaseHeatmapEntry[] {
  const churn = normalize(inputs.map((i) => i.churn90d));
  const size = normalize(inputs.map((i) => i.bytes));
  const fanIn = normalize(inputs.map((i) => i.fanIn));
  const touches = normalize(inputs.map((i) => i.agentTouches));
  return inputs
    .map((input) => ({
      ...input,
      heat: Number(
        (
          churn(input.churn90d) * HEAT_WEIGHTS.churn +
          size(input.bytes) * HEAT_WEIGHTS.size +
          fanIn(input.fanIn) * HEAT_WEIGHTS.fanIn +
          touches(input.agentTouches) * HEAT_WEIGHTS.touches
        ).toFixed(6),
      ),
    }))
    .sort(
      (a, b) =>
        b.heat - a.heat ||
        b.fanIn - a.fanIn ||
        b.churn90d - a.churn90d ||
        a.path.localeCompare(b.path),
    )
    .slice(0, limit);
}

/** Rank files by import fan-in (how many other files import them). */
export function rankKeyFilesByFanIn<T extends { fanIn: number; path: string }>(
  files: T[],
  limit = 40,
): T[] {
  return [...files]
    .sort((a, b) => b.fanIn - a.fanIn || a.path.localeCompare(b.path))
    .slice(0, limit);
}
