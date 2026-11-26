// Multi-provider eval report writer. Emits a compact markdown table (one
// row per provider × model) and a machine-readable JSON file.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderEvalReport } from "./provider-types";

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
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
  lines.push("| Provider | Model | Tasks | Completion | Mean turns | Mean input tok | Mean output tok | Mean wall-clock |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of report.rows) {
    lines.push(
      `| ${row.providerId} | ${row.model} | ${row.tasksRun} | ${pct(row.completionRate)} | ` +
        `${row.meanTurns.toFixed(1)} | ${fmtTokens(row.meanInputTokens)} | ` +
        `${fmtTokens(row.meanOutputTokens)} | ${row.meanWallClockMs.toFixed(0)}ms |`,
    );
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
