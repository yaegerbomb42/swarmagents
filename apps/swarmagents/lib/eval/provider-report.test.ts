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
  assert.match(md, /\| Provider \| Model \| Mode \| Tasks \| Completion \| pass@1 \| Mean turns \| Mean input tok \| Mean output tok \| Mean wall-clock \|/);
  // Rows without a mode are the scripted suite; no pass@1 recorded renders "—".
  assert.match(md, /\| anthropic \| claude-sonnet-4-5 \| scripted \| 6 \| 100\.0% \| — \| 8\.5 \| 12,000 \| 2,500 \| 4250ms \|/);
  assert.match(md, /\| openai \| gpt-4o \| scripted \| 6 \| 83\.3% \| — \| 10\.0 \| 15,000 \| 3,000 \| 5000ms \|/);
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

test("live rows show the mode, pass@1 and a per-trial table with exit reasons", () => {
  const md = renderProviderMarkdownTable({
    generatedAt: "x",
    rows: [
      {
        providerId: "radium",
        model: "nvidia/nemotron|x",
        mode: "live",
        tasksRun: 2,
        completionRate: 0.5,
        passAt1: 0.5,
        meanTurns: 7,
        meanInputTokens: 1000,
        meanOutputTokens: 200,
        meanWallClockMs: 30000,
      },
    ],
    trials: [
      {
        taskId: "coding-fix-rate-limiter",
        category: "coding",
        providerId: "radium",
        model: "nvidia/nemotron|x",
        trial: 1,
        resolved: true,
        partialScore: 1,
        metrics: { totalTurns: 6, totalInputTokens: 900, totalOutputTokens: 150, wallClockMs: 25_000 },
        grading: { passed: 3, failed: 0, total: 3 },
        mode: "live",
        exitReason: "completed",
      },
      {
        taskId: "web-add-contact-section",
        category: "web",
        providerId: "radium",
        model: "nvidia/nemotron|x",
        trial: 1,
        resolved: false,
        partialScore: 0,
        metrics: { totalTurns: 8, totalInputTokens: 1100, totalOutputTokens: 250, wallClockMs: 35_000 },
        grading: { passed: 0, failed: 2, total: 2 },
        mode: "live",
        exitReason: "timeout",
      },
    ],
  });
  // A "|" inside a model id never breaks the table.
  assert.match(md, /\| radium \| nvidia\/nemotron\\\|x \| live \| 2 \| 50\.0% \| 50\.0% \|/);
  assert.match(md, /pass@1 radium\/nvidia\/nemotron\\\|x \(live\): 50\.0% of 2 tasks/);
  assert.match(md, /\| coding-fix-rate-limiter \| .* \| 1 \| pass \| 3\/3 \| 6 \| 900 \| 150 \| 25\.0 \| completed \|/);
  assert.match(md, /\| web-add-contact-section \| .* \| FAIL \| 0\/2 \| 8 \| 1,100 \| 250 \| 35\.0 \| timeout \|/);
});
