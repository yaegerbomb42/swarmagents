/**
 * Unit tests for live-room resolution helpers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { pickSpectateRun } from "./room";
import type { RunSummary } from "../runtime/manager";

function run(partial: Partial<RunSummary>): RunSummary {
  return {
    runId: "run_x",
    userId: "alice",
    status: "running",
    prompt: "p",
    createdAt: 0,
    lastSeq: 0,
    kind: "agent",
    ...partial,
  } as RunSummary;
}

test("pickSpectateRun prefers the live run over queued runs", () => {
  const runs = [
    run({ runId: "a", status: "queued", position: 1 }),
    run({ runId: "b", status: "running" }),
    run({ runId: "c", status: "queued", position: 2 }),
  ];
  assert.equal(pickSpectateRun(runs)?.runId, "b");
});

test("pickSpectateRun falls back to the first queued run", () => {
  const runs = [
    run({ runId: "a", status: "queued", position: 1 }),
    run({ runId: "b", status: "queued", position: 2 }),
  ];
  assert.equal(pickSpectateRun(runs)?.runId, "a");
});

test("pickSpectateRun returns null with no runnable run", () => {
  assert.equal(pickSpectateRun([]), null);
  assert.equal(pickSpectateRun([run({ runId: "finished", status: "finished" })]), null);
});
