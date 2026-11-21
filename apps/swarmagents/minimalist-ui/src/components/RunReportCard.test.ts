/**
 * Unit tests for the run report card's plain-language summary sentence.
 *
 * The sentence is computed from data the card already has (no new fetching):
 * with the full report loaded the files phrase can name the single file;
 * from the collapsed row's meta alone it can only count. Failed and
 * cancelled runs get an explicit status prefix, still one sentence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReportCost, formatReportDuration, reportSummarySentence } from "./RunReportCard";
import type { ReportArtifact, ReportCardMeta, ReportStatus } from "../../../lib/runtime/run-report-types";

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

function artifacts(...changes: Array<"created" | "modified">): ReportArtifact[] {
  return changes.map((change, i) => ({
    path: `/workspace/f${i}`,
    rel: change === "created" ? (i === 0 ? "hello.txt" : `hello${i}.txt`) : i === 0 ? "notes.md" : `notes${i}.md`,
    size: 12,
    mtimeMs: 1000,
    change,
  }));
}

function corpus(resume: Partial<ReportCardMeta>, art?: ReportArtifact[], status: ReportStatus = "finished"): string {
  return reportSummarySentence(meta({ ...resume, status }), art);
}

test("a run with one created file names it", () => {
  assert.equal(corpus({ artifacts: 1 }, artifacts("created")), "Created hello.txt in 7s for $0.11.");
});

test("a run with one modified file says Edited", () => {
  assert.equal(reportSummarySentence(meta({ artifacts: 1 }), artifacts("modified")), "Edited notes.md in 7s for $0.11.");
});

test("a mixed run counts created and edited files", () => {
  const files = artifacts("created", "created", "modified");
  assert.equal(
    reportSummarySentence(meta({ artifacts: 3 }), files),
    "Created 2 files and edited 1 file in 7s for $0.11.",
  );
});

test("a run without files says none changed", () => {
  assert.equal(corpus({ artifacts: 0, durationMs: 12000, costUsd: 0.27 }, []), "No files changed in 12s for $0.27.");
});

test("a many-created run uses the plural count", () => {
  const files = artifacts("created", "created", "created");
  assert.equal(reportSummarySentence(meta({ artifacts: 3 }), files), "Created 3 files in 7s for $0.11.");
});

test("from meta alone the sentence counts files without naming them", () => {
  assert.equal(reportSummarySentence(meta({ artifacts: 3 })), "Changed 3 files in 7s for $0.11.");
  assert.equal(reportSummarySentence(meta({ artifacts: 1 })), "Changed 1 file in 7s for $0.11.");
  assert.equal(reportSummarySentence(meta({ artifacts: 0 })), "No files changed in 7s for $0.11.");
});

test("a failed run carries an explicit prefix and stays one sentence", () => {
  const sentence = corpus({ artifacts: 0, durationMs: 12000, costUsd: 0.27 }, [], "error");
  assert.equal(sentence, "Run failed \u2014 no files changed in 12s for $0.27.");
  assert.ok(!sentence.includes("\n"), "one sentence, no line break");
});

test("a cancelled run says stopped, not failed", () => {
  assert.equal(corpus({ artifacts: 1 }, artifacts("created"), "cancelled"), "Run stopped \u2014 created hello.txt in 7s for $0.11.");
});

test("unknown duration and cost are dropped rather than shown as dashes", () => {
  const files = artifacts("created");
  assert.equal(reportSummarySentence(meta({ durationMs: undefined, costUsd: undefined }), files), "Created hello.txt.");
  assert.equal(reportSummarySentence(meta({ durationMs: undefined }), files), "Created hello.txt for $0.11.");
  assert.equal(reportSummarySentence(meta({ costUsd: undefined }), files), "Created hello.txt in 7s.");
});

test("sub-cent costs keep three decimals; zero cost still shows", () => {
  assert.equal(formatReportCost(0.004), "$0.004");
  assert.equal(formatReportCost(0.11), "$0.11");
  assert.equal(formatReportCost(0), "$0.00");
  assert.equal(formatReportCost(undefined), "");
  assert.equal(reportSummarySentence(meta({ costUsd: 0.004 }), artifacts("created")), "Created hello.txt in 7s for $0.004.");
});

test("durations round the same way the old facts row did", () => {
  assert.equal(formatReportDuration(900), "1s");
  assert.equal(formatReportDuration(64_000), "1m 4s");
  assert.equal(reportSummarySentence(meta({ durationMs: 64_000 }), artifacts("created")), "Created hello.txt in 1m 4s for $0.11.");
});
