import test from "node:test";
import assert from "node:assert/strict";
import {
  HEATMAP_METRICS,
  LOW_COVERAGE_PCT,
  NO_DATA_FILL,
  clamp01,
  heatmapColor,
  isLowCoverage,
  metricRawValue,
  normalizeMetricValue,
} from "./heatmapColor";
import type { CodebaseHotspot } from "../../../lib/client/codebase";

function hotspot(partial: Partial<CodebaseHotspot>): CodebaseHotspot {
  return {
    path: "src/a.ts",
    churn90d: 10,
    bytes: 1000,
    fanIn: 3,
    agentTouches: 4,
    heat: 0.5,
    ...partial,
  };
}

/** The hue of an `hsl(<hue> ...)` colour string. */
function hueOf(color: string): number {
  const match = /^hsl\((\d+)/.exec(color);
  assert.ok(match, `not an hsl colour: ${color}`);
  return Number(match[1]);
}

test("clamp01 clamps to 0..1 and maps non-finite values to 0", () => {
  assert.equal(clamp01(-0.5), 0);
  assert.equal(clamp01(0), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(1), 1);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(Infinity), 0);
});

test("heatmapColor clamps out-of-range values to the ends of the scale", () => {
  assert.equal(heatmapColor("heat", -1), heatmapColor("heat", 0));
  assert.equal(heatmapColor("heat", 2), heatmapColor("heat", 1));
  assert.equal(heatmapColor("coverage", -1), heatmapColor("coverage", 0));
  assert.equal(heatmapColor("coverage", 2), heatmapColor("coverage", 1));
});

test("heatmapColor keeps the cold-blue -> hot-amber scale for heat/churn/complexity/touches", () => {
  for (const metric of ["heat", "churn", "complexity", "touches"] as const) {
    assert.equal(hueOf(heatmapColor(metric, 0)), 200);
    assert.equal(hueOf(heatmapColor(metric, 1)), 10);
    assert.ok(hueOf(heatmapColor(metric, 0.5)) > hueOf(heatmapColor(metric, 1)));
    assert.ok(hueOf(heatmapColor(metric, 0.5)) < hueOf(heatmapColor(metric, 0)));
  }
});

test("heatmapColor inverts coverage: low coverage is hot red/amber, high coverage is cool green", () => {
  // 0% covered is red (hue 0); 100% covered is cool green (hue 160).
  assert.equal(hueOf(heatmapColor("coverage", 0)), 0);
  assert.equal(hueOf(heatmapColor("coverage", 1)), 160);
  // A barely-tested file is hotter (lower hue) than a well-tested one.
  assert.ok(hueOf(heatmapColor("coverage", 0.1)) < hueOf(heatmapColor("coverage", 0.9)));
  // Mid coverage lands amber-ish, between red and green.
  const mid = hueOf(heatmapColor("coverage", 0.5));
  assert.ok(mid > 0 && mid < 160, `mid hue ${mid}`);
});

test("heatmapColor renders null / non-finite values as the dimmed no-data fill, never as zero", () => {
  assert.equal(heatmapColor("coverage", null), NO_DATA_FILL);
  assert.equal(heatmapColor("heat", null), NO_DATA_FILL);
  assert.equal(heatmapColor("heat", Number.NaN), NO_DATA_FILL);
  assert.notEqual(NO_DATA_FILL, heatmapColor("heat", 0));
  assert.notEqual(NO_DATA_FILL, heatmapColor("coverage", 0));
});

test("metricRawValue reads each metric from the hotspot", () => {
  const h = hotspot({ heat: 0.7, churn90d: 12, agentTouches: 9, complexity: 42, coveragePct: 33 });
  assert.equal(metricRawValue(h, "heat"), 0.7);
  assert.equal(metricRawValue(h, "churn"), 12);
  assert.equal(metricRawValue(h, "complexity"), 42);
  assert.equal(metricRawValue(h, "coverage"), 33);
  assert.equal(metricRawValue(h, "touches"), 9);
});

test("metricRawValue falls back to churn when complexity is absent, and null for unknown coverage", () => {
  const h = hotspot({ churn90d: 12 });
  assert.equal(metricRawValue(h, "complexity"), 12);
  assert.equal(metricRawValue(h, "coverage"), null);
  assert.equal(metricRawValue(hotspot({ coveragePct: null }), "coverage"), null);
});

test("normalizeMetricValue normalises against the max and clamps", () => {
  assert.equal(normalizeMetricValue(50, 100), 0.5);
  assert.equal(normalizeMetricValue(150, 100), 1);
  assert.equal(normalizeMetricValue(0, 100), 0);
  assert.equal(normalizeMetricValue(5, 0), 0);
  assert.equal(normalizeMetricValue(Number.NaN, 100), 0);
});

test("isLowCoverage treats unknown and low coverage as low, high coverage as not low", () => {
  assert.equal(isLowCoverage(hotspot({})), true);
  assert.equal(isLowCoverage(hotspot({ coveragePct: null })), true);
  assert.equal(isLowCoverage(hotspot({ coveragePct: 0 })), true);
  assert.equal(isLowCoverage(hotspot({ coveragePct: LOW_COVERAGE_PCT - 1 })), true);
  assert.equal(isLowCoverage(hotspot({ coveragePct: LOW_COVERAGE_PCT })), false);
  assert.equal(isLowCoverage(hotspot({ coveragePct: 90 })), false);
});

test("HEATMAP_METRICS covers all five modes with distinct headings", () => {
  const ids = HEATMAP_METRICS.map((def) => def.id).sort();
  assert.deepEqual(ids, ["churn", "complexity", "coverage", "heat", "touches"]);
  const headings = new Set(HEATMAP_METRICS.map((def) => def.heading));
  assert.equal(headings.size, HEATMAP_METRICS.length);
  for (const def of HEATMAP_METRICS) {
    assert.ok(def.legend.length > 0, `${def.id} legend`);
  }
});
