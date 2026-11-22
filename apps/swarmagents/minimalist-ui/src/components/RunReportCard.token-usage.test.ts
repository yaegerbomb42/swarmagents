/**
 * Unit tests for the run report card's token-usage surface: the compact
 * token count, the card facts line, the per-model usage lines (including
 * the reported-vs-estimated cost labels), and the transcript's Token
 * usage section.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTranscriptMarkdown,
  costProvenanceLabel,
  formatTokenCount,
  metaCostProvenanceLabel,
  reportFacts,
  reportSummarySentence,
  tokenUsageLines,
} from "./RunReportCard";
import type { ReportCardMeta, RunReport } from "../../../lib/runtime/run-report-types";

function meta(overrides: Partial<ReportCardMeta> = {}): ReportCardMeta {
  return {
    status: "finished",
    steps: 3,
    shots: 1,
    artifacts: 1,
    durationMs: 7000,
    costUsd: 0.11,
    providers: [],
    ...overrides,
  };
}

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "run_1",
    userId: "alice",
    status: "finished",
    prompt: "build it",
    createdAt: 1_000,
    finishedAt: 8_000,
    couldNotDo: [],
    steps: [],
    artifacts: [],
    shots: [],
    meta: meta(),
    ...overrides,
  };
}

test("formatTokenCount compacts counts and dashes junk", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1234), "1.2k");
  assert.equal(formatTokenCount(34_000), "34k");
  assert.equal(formatTokenCount(1_100_000), "1.1M");
  assert.equal(formatTokenCount(undefined), "—");
  assert.equal(formatTokenCount(Number.NaN), "—");
});

test("reportFacts includes the token total only when the meta carries one", () => {
  assert.deepEqual(reportFacts(meta()), ["3 steps", "7s", "1 file changed", "$0.110"]);
  assert.deepEqual(reportFacts(meta({ tokensIn: 2100, tokensOut: 320 })), [
    "3 steps",
    "7s",
    "1 file changed",
    "2.4k tokens",
    "$0.110",
  ]);
});

test("tokenUsageLines renders per-model lines, a total, and unknown costs honestly", () => {
  const lines = tokenUsageLines(
    report({
      tokenAccounting: {
        byModel: [
          {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            calls: 2,
            okCalls: 2,
            inputTokens: 2000,
            outputTokens: 300,
            costUsd: 0.0105,
            unknownCostCalls: 0,
            reportedCostCalls: 0,
          },
          {
            provider: "inception",
            model: "mercury-3",
            calls: 1,
            okCalls: 1,
            inputTokens: 100,
            outputTokens: 20,
            unknownCostCalls: 1,
            reportedCostCalls: 0,
          },
        ],
        totals: { calls: 3, okCalls: 3, inputTokens: 2100, outputTokens: 320, costUsd: 0.0105, unknownCostCalls: 1, reportedCostCalls: 0 },
      },
    }),
  );
  assert.deepEqual(lines, [
    "- anthropic/claude-sonnet-4-5: 2/2 calls, 2.0k in / 300 out, $0.011 (estimated)",
    "- inception/mercury-3: 1/1 calls, 100 in / 20 out, cost unknown",
    "- Total: 3/3 calls, 2.1k in / 320 out, $0.011 (estimated)",
  ]);
});

test("tokenUsageLines falls back to the harness line and is empty without accounting", () => {
  assert.deepEqual(tokenUsageLines(report()), []);
  assert.deepEqual(
    tokenUsageLines(
      report({
        tokenAccounting: {
          byModel: [],
          totals: { calls: 0, okCalls: 0, inputTokens: 0, outputTokens: 0, unknownCostCalls: 0, reportedCostCalls: 0 },
          harness: { inputTokens: 750, outputTokens: 100, cachedTokens: 100 },
        },
      }),
    ),
    ["- 750 in / 100 out (100 cached)"],
  );
});

test("transcript carries the Token usage section only when accounting exists", () => {
  const withUsage = buildTranscriptMarkdown(
    report({
      tokenAccounting: {
        byModel: [
          {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            calls: 1,
            okCalls: 1,
            inputTokens: 1000,
            outputTokens: 100,
            costUsd: 0.0045,
            unknownCostCalls: 0,
            reportedCostCalls: 0,
          },
        ],
        totals: { calls: 1, okCalls: 1, inputTokens: 1000, outputTokens: 100, costUsd: 0.0045, unknownCostCalls: 0, reportedCostCalls: 0 },
      },
    }),
  );
  assert.match(withUsage, /## Token usage/);
  assert.match(withUsage, /anthropic\/claude-sonnet-4-5: 1\/1 calls, 1\.0k in \/ 100 out, \$0\.004 \(estimated\)/);
  assert.doesNotMatch(buildTranscriptMarkdown(report()), /## Token usage/);
});

test("costProvenanceLabel classifies reported, estimated, and mixed from the counts", () => {
  // Every priced call provider-reported.
  assert.equal(
    costProvenanceLabel({ costUsd: 0.042, calls: 2, unknownCostCalls: 0, reportedCostCalls: 2 }),
    "reported",
  );
  // No priced call provider-reported.
  assert.equal(
    costProvenanceLabel({ costUsd: 0.011, calls: 2, unknownCostCalls: 0, reportedCostCalls: 0 }),
    "estimated",
  );
  // Some of each: counts ride along (priced = calls − unknown).
  assert.equal(
    costProvenanceLabel({ costUsd: 0.05, calls: 4, unknownCostCalls: 1, reportedCostCalls: 2 }),
    "mixed: 2 reported, 1 estimated",
  );
  // Legacy reports (no reportedCostCalls field) read as estimated — every
  // cost was an estimate before reported costs were captured.
  assert.equal(
    costProvenanceLabel({ costUsd: 0.011, calls: 2, unknownCostCalls: 0, reportedCostCalls: undefined as unknown as number }),
    "estimated",
  );
  // Inconsistent counts clamp instead of producing nonsense.
  assert.equal(
    costProvenanceLabel({ costUsd: 0.01, calls: 1, unknownCostCalls: 0, reportedCostCalls: 5 }),
    "reported",
  );
});

test("costProvenanceLabel stays silent when there is no figure to label", () => {
  // Cost unknown.
  assert.equal(costProvenanceLabel({ calls: 1, unknownCostCalls: 1, reportedCostCalls: 0 }), undefined);
  // $0 figures (free providers, reported zeros) stand alone, unlabeled.
  assert.equal(costProvenanceLabel({ costUsd: 0, calls: 3, unknownCostCalls: 0, reportedCostCalls: 0 }), undefined);
  assert.equal(costProvenanceLabel({ costUsd: 0, calls: 3, unknownCostCalls: 0, reportedCostCalls: 3 }), undefined);
  // A figure with no priced calls cannot be classified honestly.
  assert.equal(costProvenanceLabel({ costUsd: 0.01, calls: 1, unknownCostCalls: 1, reportedCostCalls: 0 }), undefined);
  // Junk numbers never produce a label.
  assert.equal(costProvenanceLabel({ costUsd: Number.NaN, calls: 1, unknownCostCalls: 0, reportedCostCalls: 1 }), undefined);
  assert.equal(costProvenanceLabel({ costUsd: -1, calls: 1, unknownCostCalls: 0, reportedCostCalls: 1 }), undefined);
});

test("tokenUsageLines labels provider-reported and mixed costs per model and in total", () => {
  const lines = tokenUsageLines(
    report({
      tokenAccounting: {
        byModel: [
          {
            provider: "perplexity",
            model: "sonar",
            calls: 2,
            okCalls: 2,
            inputTokens: 1500,
            outputTokens: 200,
            costUsd: 0.042,
            unknownCostCalls: 0,
            reportedCostCalls: 2,
          },
          {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            calls: 4,
            okCalls: 4,
            inputTokens: 3000,
            outputTokens: 400,
            costUsd: 0.05,
            unknownCostCalls: 1,
            reportedCostCalls: 2,
          },
        ],
        totals: { calls: 6, okCalls: 6, inputTokens: 4500, outputTokens: 600, costUsd: 0.092, unknownCostCalls: 1, reportedCostCalls: 4 },
      },
    }),
  );
  assert.deepEqual(lines, [
    "- perplexity/sonar: 2/2 calls, 1.5k in / 200 out, $0.042 (reported)",
    "- anthropic/claude-sonnet-4-5: 4/4 calls, 3.0k in / 400 out, $0.050 (mixed: 2 reported, 1 estimated) (+1 unpriced)",
    "- Total: 6/6 calls, 4.5k in / 600 out, $0.092 (mixed: 4 reported, 1 estimated)",
  ]);
});

test("metaCostProvenanceLabel reads the recorded provenance, silent without a figure", () => {
  assert.equal(metaCostProvenanceLabel(meta({ costProvenance: "reported" })), "reported");
  assert.equal(metaCostProvenanceLabel(meta({ costProvenance: "estimated" })), "estimated");
  assert.equal(metaCostProvenanceLabel(meta({ costProvenance: "mixed" })), "mixed");
  // Legacy reports (no provenance recorded) stand bare.
  assert.equal(metaCostProvenanceLabel(meta()), undefined);
  // $0 figures stand bare even when provenance was recorded.
  assert.equal(metaCostProvenanceLabel(meta({ costUsd: 0, costProvenance: "reported" })), undefined);
  // No figure / junk figure: no label.
  assert.equal(metaCostProvenanceLabel(meta({ costUsd: undefined, costProvenance: "reported" })), undefined);
  assert.equal(metaCostProvenanceLabel(meta({ costUsd: Number.NaN, costProvenance: "reported" })), undefined);
});

test("collapsed summary and facts carry the meta provenance label", () => {
  assert.equal(
    reportSummarySentence(meta({ costProvenance: "reported" })),
    "Changed 1 file in 7s for $0.11 (reported).",
  );
  assert.equal(
    reportSummarySentence(meta({ costProvenance: "estimated" })),
    "Changed 1 file in 7s for $0.11 (estimated).",
  );
  assert.equal(
    reportSummarySentence(meta({ costProvenance: "mixed" })),
    "Changed 1 file in 7s for $0.11 (mixed).",
  );
  assert.deepEqual(reportFacts(meta({ costProvenance: "reported" })), [
    "3 steps",
    "7s",
    "1 file changed",
    "$0.110 (reported)",
  ]);
});

test("legacy meta without provenance renders exactly as before", () => {
  assert.equal(reportSummarySentence(meta()), "Changed 1 file in 7s for $0.11.");
  assert.deepEqual(reportFacts(meta()), ["3 steps", "7s", "1 file changed", "$0.110"]);
  assert.match(buildTranscriptMarkdown(report()), /\*\*Duration \/ cost:\*\* 7s · \$0\.110\n/);
});

test("free ($0) meta cost renders exactly as before, provenance or not", () => {
  assert.equal(reportSummarySentence(meta({ costUsd: 0 })), "Changed 1 file in 7s for $0.00.");
  assert.equal(reportSummarySentence(meta({ costUsd: 0, costProvenance: "estimated" })), "Changed 1 file in 7s for $0.00.");
  assert.deepEqual(reportFacts(meta({ costUsd: 0, costProvenance: "reported" })), [
    "3 steps",
    "7s",
    "1 file changed",
    "$0.000",
  ]);
});

test("transcript Duration / cost line carries the meta provenance label", () => {
  const md = buildTranscriptMarkdown(report({ meta: meta({ costProvenance: "mixed" }) }));
  assert.match(md, /\*\*Duration \/ cost:\*\* 7s · \$0\.110 \(mixed\)/);
});

test("tokenUsageLines leaves free ($0) runs exactly as before", () => {
  const lines = tokenUsageLines(
    report({
      tokenAccounting: {
        byModel: [
          {
            provider: "inception",
            model: "mercury-3",
            calls: 3,
            okCalls: 3,
            inputTokens: 900,
            outputTokens: 120,
            costUsd: 0,
            unknownCostCalls: 0,
            reportedCostCalls: 0,
          },
        ],
        totals: { calls: 3, okCalls: 3, inputTokens: 900, outputTokens: 120, costUsd: 0, unknownCostCalls: 0, reportedCostCalls: 0 },
      },
    }),
  );
  assert.deepEqual(lines, ["- inception/mercury-3: 3/3 calls, 900 in / 120 out, $0.000"]);
});
