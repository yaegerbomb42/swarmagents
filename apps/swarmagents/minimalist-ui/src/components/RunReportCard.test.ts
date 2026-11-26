/**
 * Unit tests for the run report card's plain-language summary sentence
 * and copy-transcript functionality.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatReportCost, formatReportDuration, reportSummarySentence } from "./RunReportCard";
import type { ReportArtifact, ReportCardMeta, ReportStatus, RunReport } from "../../../lib/runtime/run-report-types";
import { countOf, installBrowserStubs } from "../testing/harness";

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

function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "run_1",
    userId: "user_1",
    status: "finished",
    prompt: "Create hello.txt and run it",
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_007_432,
    couldNotDo: [],
    steps: [
      { seq: 0, ts: 1, kind: "start", text: "Run started" },
      { seq: 1, ts: 2, kind: "tool", text: "Creating hello.txt", ok: true, detail: "echo hi > hello.txt" },
      { seq: 2, ts: 3, kind: "tool", text: "Running the script", ok: false },
      { seq: 3, ts: 4, kind: "blocked", text: "Network access blocked" },
    ],
    artifacts: [
      {
        path: "/workspace/hello.txt",
        rel: "hello.txt",
        size: 12,
        mtimeMs: 5,
        change: "created",
      },
    ],
    shots: [],
    meta: {
      status: "finished",
      steps: 4,
      shots: 0,
      artifacts: 1,
      durationMs: 7_432,
      costUsd: 0.11,
      providers: [],
    },
    ...overrides,
  };
}

// Node exposes navigator as a read-only getter, so redefine it for the clipboard tests.
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
function stubNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}
function restoreNavigator(): void {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete (globalThis as unknown as Record<string, unknown>).navigator;
}

test("the transcript mirrors the report: prompt, steps with outcomes, files, duration and cost", async () => {
  const { buildTranscriptMarkdown } = await import("./RunReportCard");
  const md = buildTranscriptMarkdown(makeReport());
  assert.match(md, /^# Run transcript/);
  assert.match(md, /Status: finished/);
  assert.match(md, /## Prompt\n\nCreate hello\.txt and run it/);
  assert.match(md, /## Timeline/);
  const order = [
    "- Run started",
    "- Creating hello.txt (done) — echo hi > hello.txt",
    "- Running the script (failed)",
    "- Network access blocked (blocked)",
  ].map((line) => md.indexOf(line));
  assert.ok(order.every((i) => i >= 0), "every step is present");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "steps stay in order");
  assert.match(md, /## Files changed\n\n- created: `hello\.txt` \(12 B\)/);
  assert.match(md, /\*\*Duration \/ cost:\*\* 7s · \$0\.110/);
  assert.match(md, /\n$/);
});

test("a report with no steps or files still produces a complete transcript", async () => {
  const { buildTranscriptMarkdown } = await import("./RunReportCard");
  const md = buildTranscriptMarkdown(
    makeReport({
      status: "error",
      steps: [],
      artifacts: [],
      meta: { status: "error", steps: 0, shots: 0, artifacts: 0, providers: [] },
    }),
  );
  assert.match(md, /Status: error/);
  assert.match(md, /_No steps recorded\._/);
  assert.match(md, /No files changed\./);
  assert.match(md, /\*\*Duration \/ cost:\*\* —/);
});

test("the copy button shows the idle and brief Copied states", async () => {
  installBrowserStubs({});
  const { CopyTranscriptButton } = await import("./RunReportCard");
  const idle = renderToStaticMarkup(React.createElement(CopyTranscriptButton, { copied: false, onCopy() {} }));
  assert.equal(countOf(idle, 'data-testid="copy-transcript"'), 1);
  assert.match(idle, /Copy transcript/);
  assert.doesNotMatch(idle, /Copied/);
  const done = renderToStaticMarkup(React.createElement(CopyTranscriptButton, { copied: true, onCopy() {} }));
  assert.match(done, />Copied</);
  assert.doesNotMatch(done, /Copy transcript/);
});

test("copy uses the clipboard API when it is allowed", async () => {
  const { copyTextWithFallback } = await import("./RunReportCard");
  let written: string | undefined;
  stubNavigator({ clipboard: { writeText: async (text: string) => { written = text; } } });
  try {
    assert.equal(await copyTextWithFallback("hello"), true);
    assert.equal(written, "hello");
  } finally {
    restoreNavigator();
  }
});

test("denied clipboard permission falls back to select-and-copy", async () => {
  const { copyTextWithFallback } = await import("./RunReportCard");
  const g = globalThis as unknown as Record<string, unknown>;
  const previousDoc = g.document;
  const area = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute() {},
    select() { selected = true; },
    remove() {},
  };
  let selected = false;
  let copied = false;
  stubNavigator({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
  g.document = {
    createElement: () => area,
    body: { appendChild() {} },
    execCommand: (command: string) => { copied = command === "copy"; return true; },
  };
  try {
    assert.equal(await copyTextWithFallback("fallback text"), true);
    assert.equal(area.value, "fallback text");
    assert.ok(selected, "the fallback text is selected");
    assert.ok(copied, "execCommand('copy') is used");
  } finally {
    restoreNavigator();
    g.document = previousDoc;
  }
});

test("a totally unavailable clipboard reports failure so the user gets a manual notice", async () => {
  const { copyTextWithFallback } = await import("./RunReportCard");
  const g = globalThis as unknown as Record<string, unknown>;
  const previousDoc = g.document;
  stubNavigator({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
  g.document = { createElement: () => { throw new Error("no DOM"); } };
  try {
    assert.equal(await copyTextWithFallback("text"), false);
  } finally {
    restoreNavigator();
    g.document = previousDoc;
  }
});

test("summary sentence ends with the plan progress when the run planned", () => {
  assert.equal(
    reportSummarySentence(meta({ artifacts: 1, plan: { done: 7, total: 7 } }), artifacts("modified")),
    "Edited notes.md in 7s for $0.11. Plan: 7/7 completed.",
  );
  assert.equal(reportSummarySentence(meta({ artifacts: 1 }), artifacts("modified")), "Edited notes.md in 7s for $0.11.");
});
