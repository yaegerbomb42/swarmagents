import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderProviderMarkdownTable, writeProviderReport } from "./provider-report";
import type { ProviderEvalReport } from "./provider-types";

const report: ProviderEvalReport = {
  generatedAt: "2026-11-26T00:00:00.000Z",
  rows: [
    {
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
      tasksRun: 6,
      completionRate: 1,
      meanTurns: 8.5,
      meanInputTokens: 12000,
      meanOutputTokens: 2500,
      meanWallClockMs: 4250,
    },
    {
      providerId: "openai",
      model: "gpt-4o",
      tasksRun: 6,
      completionRate: 0.8333,
      meanTurns: 10,
      meanInputTokens: 15000,
      meanOutputTokens: 3000,
      meanWallClockMs: 5000,
    },
  ],
};

test("renderProviderMarkdownTable renders a header and one row per provider", () => {
  const md = renderProviderMarkdownTable(report);
  assert.match(md, /# Multi-Provider Real-Task Desktop Eval/);
  assert.match(md, /\| Provider \| Model \| Tasks \| Completion \| Mean turns \| Mean input tok \| Mean output tok \| Mean wall-clock \|/);
  assert.match(md, /\| anthropic \| claude-sonnet-4-5 \| 6 \| 100\.0% \| 8\.5 \| 12,000 \| 2,500 \| 4250ms \|/);
  assert.match(md, /\| openai \| gpt-4o \| 6 \| 83\.3% \| 10\.0 \| 15,000 \| 3,000 \| 5000ms \|/);
});

test("writeProviderReport writes JSON and markdown files", async (t) => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "swarm-eval-provider-report-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const { jsonPath, markdownPath } = await writeProviderReport(outDir, report);
  const json = JSON.parse(await readFile(jsonPath, "utf8")) as ProviderEvalReport;
  assert.equal(json.rows.length, 2);
  assert.equal(json.rows[0].providerId, "anthropic");
  const md = await readFile(markdownPath, "utf8");
  assert.match(md, /anthropic/);
  assert.match(md, /openai/);
});

test("an empty report renders a header with no data rows", () => {
  const md = renderProviderMarkdownTable({ generatedAt: "x", rows: [] });
  assert.match(md, /# Multi-Provider Real-Task Desktop Eval/);
  assert.doesNotMatch(md, /\| [a-z]+ \| .* \| [0-9]+ \|/);
});
