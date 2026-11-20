import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUN_PHASE_META,
  deriveRunPhase,
  formatDuration,
  formatElapsed,
  isRunActive,
  type RunPhase,
} from "./runPhase";

test("no run means no phase", () => {
  assert.equal(deriveRunPhase({}), null);
  assert.equal(deriveRunPhase({ status: "unknown-status" }), null);
  assert.equal(isRunActive(null), false);
  assert.equal(isRunActive(undefined), false);
});

test("every status the runs API reports maps to one phase", () => {
  const cases: Array<[string, RunPhase]> = [
    ["queued", "queued"],
    ["running", "running"],
    ["paused", "paused"],
    ["finished", "finished"],
    ["error", "error"],
    ["cancelled", "cancelled"],
  ];
  for (const [status, phase] of cases) assert.equal(deriveRunPhase({ status }), phase, status);
});

test("a finished status from the API wins over anything still pending", () => {
  assert.equal(deriveRunPhase({ status: "finished", pendingApprovals: 2, pendingQuestions: 1 }), "finished");
  assert.equal(deriveRunPhase({ status: "cancelled", terminalEvent: "run.finished" }), "cancelled");
});

test("a terminal stream event shows before the next poll catches up", () => {
  assert.equal(deriveRunPhase({ status: "running", terminalEvent: "run.finished" }), "finished");
  assert.equal(deriveRunPhase({ status: "running", terminalEvent: "run.error" }), "error");
  assert.equal(deriveRunPhase({ status: "running", terminalEvent: "run.cancelled" }), "cancelled");
  assert.equal(deriveRunPhase({ status: "running", terminalEvent: "run.paused" }), "paused");
  assert.equal(deriveRunPhase({ status: "running", terminalEvent: "assistant.text" }), "running");
});

test("waiting on the user outranks running: approval first, then a question", () => {
  assert.equal(deriveRunPhase({ status: "running", pendingApprovals: 1, pendingQuestions: 1 }), "approval");
  assert.equal(deriveRunPhase({ status: "running", pendingQuestions: 1 }), "question");
  assert.equal(deriveRunPhase({ status: "running", pendingApprovals: 0, pendingQuestions: 0 }), "running");
});

test("a send in flight shows Starting until the server reports a status", () => {
  assert.equal(deriveRunPhase({ dispatching: true }), "starting");
  assert.equal(deriveRunPhase({ dispatching: true, status: "queued" }), "queued");
  assert.equal(deriveRunPhase({ dispatching: true, status: "running" }), "running");
});

test("each phase has one label and one tone, and only live phases offer Stop", () => {
  const labels = Object.values(RUN_PHASE_META).map((meta) => meta.label);
  assert.equal(new Set(labels).size, labels.length, "labels are distinct");
  assert.deepEqual(
    Object.fromEntries(Object.entries(RUN_PHASE_META).map(([phase, meta]) => [phase, meta.label])),
    {
      starting: "Starting",
      queued: "Queued",
      running: "Running",
      approval: "Needs approval",
      question: "Needs your answer",
      paused: "Paused",
      finished: "Finished",
      error: "Failed",
      cancelled: "Stopped",
    },
  );
  const active = (Object.keys(RUN_PHASE_META) as RunPhase[]).filter((phase) => isRunActive(phase));
  assert.deepEqual(active.sort(), ["approval", "question", "queued", "running", "starting"]);
  assert.equal(RUN_PHASE_META.error.tone, "err");
  assert.equal(RUN_PHASE_META.finished.tone, "ok");
  assert.equal(RUN_PHASE_META.approval.tone, "warn");
});

test("formatElapsed is a clock", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(7_400), "0:07");
  assert.equal(formatElapsed(84_000), "1:24");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
  assert.equal(formatElapsed(-5), "0:00");
});

test("formatDuration reads as a length of time", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(42_400), "42s");
  assert.equal(formatDuration(185_000), "3m 05s");
  assert.equal(formatDuration(3_720_000), "1h 02m");
});
