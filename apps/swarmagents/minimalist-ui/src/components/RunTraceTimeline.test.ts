/**
 * Static-render tests for the trace timeline's Rewind affordance (core-17):
 * a gate-checkpointed step shows a Rewind button only when the run is known,
 * and steps without a checkpoint never do.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunTraceTimeline } from "./RunTraceTimeline";
import type { TimelineStep } from "../../../lib/client/traceTimeline";
import { countOf, installBrowserStubs } from "../testing/harness";

function step(overrides: Partial<TimelineStep>): TimelineStep {
  return {
    id: "c1",
    kind: "bash",
    toolName: "Bash",
    label: "Running rm -rf build",
    status: "done",
    startedAt: 1_000,
    endedAt: 1_050,
    durationMs: 50,
    ok: true,
    preview: "Running rm -rf build",
    ...overrides,
  };
}

const checkpointed = step({ checkpoint: { stepSeq: 4, label: "auto-pre-step-4" } });

test("a checkpointed step with a known run shows the Rewind button", () => {
  installBrowserStubs();
  const html = renderToStaticMarkup(
    React.createElement(RunTraceTimeline, { steps: [checkpointed], runId: "run_abc", defaultOpen: true }),
  );
  assert.equal(countOf(html, 'data-testid="trace-rewind"'), 1);
  assert.match(html, /Rewind/);
});

test("steps without a checkpoint or without a run never show Rewind", () => {
  installBrowserStubs();
  const plain = renderToStaticMarkup(
    React.createElement(RunTraceTimeline, { steps: [step({})], runId: "run_abc", defaultOpen: true }),
  );
  assert.equal(countOf(plain, 'data-testid="trace-rewind"'), 0);

  const noRun = renderToStaticMarkup(
    React.createElement(RunTraceTimeline, { steps: [checkpointed], defaultOpen: true }),
  );
  assert.equal(countOf(noRun, 'data-testid="trace-rewind"'), 0);
});

test("RewindButton: first click only asks; confirm row names the undo point", async () => {
  const { RewindButton } = await import("./RunTraceTimeline");
  const idle = renderToStaticMarkup(React.createElement(RewindButton, { runId: "run_1", stepSeq: 2, label: "auto-pre-step-2" }));
  assert.ok(idle.includes('data-testid="trace-rewind"'));
  assert.ok(!idle.includes("trace-rewind-go"));
  const confirm = renderToStaticMarkup(
    React.createElement(RewindButton, { runId: "run_1", stepSeq: 2, label: "auto-pre-step-2", initialState: "confirm" }),
  );
  assert.ok(confirm.includes('data-testid="trace-rewind-confirm"'));
  assert.ok(confirm.includes("undo point"));
  assert.ok(confirm.includes('data-testid="trace-rewind-go"'));
  assert.ok(confirm.includes('data-testid="trace-rewind-cancel"'));
});
