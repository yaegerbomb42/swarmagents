// Multi-provider eval report writer. Emits a compact markdown table (one
// row per provider × model) and a machine-readable JSON file.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderEvalReport } from "./provider-types";

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** Keep a value inside one markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function renderProviderMarkdownTable(report: ProviderEvalReport): string {
  const lines: string[] = [];
  lines.push("# Multi-Provider Real-Task Desktop Eval");
  lines.push("");
  lines.push(`Generated ${report.generatedAt}`);
  lines.push("");
  lines.push("| Provider | Model | Mode | Tasks | Completion | pass@1 | Mean turns | Mean input tok | Mean output tok | Mean wall-clock |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of report.rows) {
    lines.push(
      `| ${cell(row.providerId)} | ${cell(row.model)} | ${row.mode ?? "scripted"} | ${row.tasksRun} | ${pct(row.completionRate)} | ` +
        `${row.passAt1 === undefined ? "—" : pct(row.passAt1)} | ` +
        `${row.meanTurns.toFixed(1)} | ${fmtTokens(row.meanInputTokens)} | ` +
        `${fmtTokens(row.meanOutputTokens)} | ${row.meanWallClockMs.toFixed(0)}ms |`,
    );
  }
  lines.push("");
  for (const row of report.rows) {
    if (row.passAt1 !== undefined) {
      lines.push(`pass@1 ${cell(row.providerId)}/${cell(row.model)} (${row.mode ?? "scripted"}): ${pct(row.passAt1)} of ${row.tasksRun} tasks`);
    }
  }
  const trials = report.trials ?? [];
  if (trials.length > 0) {
    lines.push("");
    lines.push("## Trials");
    lines.push("");
    lines.push("| Task | Provider | Model | Trial | Result | Tests | Turns | Input tok | Output tok | Seconds | Exit |");
    lines.push("| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const t of trials) {
      const exit = t.exitReason ? `${t.exitReason}${t.exitDetail ? `: ${cell(t.exitDetail).slice(0, 80)}` : ""}` : "—";
      lines.push(
        `| ${t.taskId} | ${cell(t.providerId)} | ${cell(t.model)} | ${t.trial} | ${t.resolved ? "pass" : "FAIL"} | ` +
          `${t.grading.passed}/${t.grading.total} | ${t.metrics.totalTurns} | ${fmtTokens(t.metrics.totalInputTokens)} | ` +
          `${fmtTokens(t.metrics.totalOutputTokens)} | ${(t.metrics.wallClockMs / 1000).toFixed(1)} | ${exit} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeProviderReport(
  outDir: string,
  report: ProviderEvalReport,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "provider-eval-report.json");
  const markdownPath = path.join(outDir, "provider-eval-report.md");
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(markdownPath, renderProviderMarkdownTable(report), "utf8");
  return { jsonPath, markdownPath };
}
