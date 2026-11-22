// Markdown + JSON report writers. pareto-report.json is the machine
// readable gate output; report.md is the PR summary table.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvalReport, ParetoComparison } from "./types";

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function renderMarkdownReport(
  report: EvalReport,
  comparison?: ParetoComparison
): string {
  const lines: string[] = [];
  lines.push(`# Harness Eval Report — ${report.configName}`);
  lines.push("");
  lines.push(
    `Profile \`${report.profile}\` · model tier \`${report.modelTier}\` · ` +
      `${report.tasksRun} tasks × ${report.trialsPerTask} trials · generated ${report.generatedAt}`
  );
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Solve rate (pass@1) | ${pct(report.solveRate)} (95% CI ${pct(report.solveRateCi95[0])}–${pct(report.solveRateCi95[1])}) |`);
  lines.push(`| Mean total tokens / task | ${fmtTokens(report.meanTotalTokens)} |`);
  lines.push(`| Mean cost / task | $${report.meanCostUsd.toFixed(4)} |`);
  lines.push(`| Mean turns / task | ${report.meanTurns.toFixed(1)} |`);
  lines.push("");
  lines.push("## By bucket");
  lines.push("");
  lines.push("| Bucket | Tasks | Solve rate | Mean tokens | Mean turns |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const bucket of ["surgical", "feature", "long-horizon"] as const) {
    const b = report.byBucket[bucket];
    lines.push(
      `| ${bucket} | ${b.tasks} | ${pct(b.solveRate)} | ${fmtTokens(b.meanTotalTokens)} | ${b.meanTurns.toFixed(1)} |`
    );
  }
  lines.push("");
  lines.push("## Per task");
  lines.push("");
  lines.push("| Task | Bucket | Pass rate | Mean tokens | Mean turns | p50 / p95 turns | Cache hit |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const t of report.perTask) {
    lines.push(
      `| ${t.taskId} | ${t.bucket} | ${pct(t.passRate)} | ${fmtTokens(t.meanTotalTokens)} | ${t.meanTurns.toFixed(1)} | ${t.p50Turns} / ${t.p95Turns} | ${pct(t.meanCacheHitRate)} |`
    );
  }
  if (comparison) {
    lines.push("");
    lines.push(`## Pareto gate — ${comparison.candidate} vs ${comparison.baseline}`);
    lines.push("");
    lines.push(
      `Verdict: **${comparison.regression ? "REGRESSION" : "PASS"}** — ` +
        `solve-rate delta ${(comparison.solveRateDelta * 100).toFixed(1)}pp, ` +
        `token delta ${(comparison.tokenDeltaFrac * 100).toFixed(1)}%, ` +
        `solve-rate diff 95% CI [${comparison.solveRateDiffCi95[0].toFixed(3)}, ${comparison.solveRateDiffCi95[1].toFixed(3)}]`
    );
    if (comparison.reasons.length > 0) {
      lines.push("");
      for (const reason of comparison.reasons) {
        lines.push(`- ${reason}`);
      }
    }
    lines.push("");
    lines.push("| Bucket | Solve-rate delta | Token delta |");
    lines.push("| --- | ---: | ---: |");
    for (const b of comparison.perBucket) {
      lines.push(
        `| ${b.bucket} | ${(b.solveRateDelta * 100).toFixed(1)}pp | ${(b.tokenDeltaFrac * 100).toFixed(1)}% |`
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export interface ParetoReportFile {
  baseline: EvalReport;
  candidate: EvalReport;
  comparison: ParetoComparison;
}

export async function writeParetoReport(
  outDir: string,
  baseline: EvalReport,
  candidate: EvalReport,
  comparison: ParetoComparison
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "pareto-report.json");
  const markdownPath = path.join(outDir, "report.md");
  const file: ParetoReportFile = { baseline, candidate, comparison };
  await writeFile(jsonPath, JSON.stringify(file, null, 2) + "\n", "utf8");
  const markdown =
    renderMarkdownReport(baseline) +
    "\n---\n\n" +
    renderMarkdownReport(candidate, comparison);
  await writeFile(markdownPath, markdown, "utf8");
  return { jsonPath, markdownPath };
}
