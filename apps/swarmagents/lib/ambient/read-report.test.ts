import test from "node:test";
import assert from "node:assert/strict";
import { createReadReport, type RunReportLike } from "./read-report";

test("readReport reads the run report exactly once per delivery", () => {
  let calls = 0;
  const read = (runId: string): RunReportLike | null => {
    calls += 1;
    assert.equal(runId, "run_1");
    return { status: "finished", finalText: "worked through the backlog" };
  };
  const readReport = createReadReport(read);
  const out = readReport("run_1");
  assert.equal(calls, 1);
  assert.equal(out?.status, "finished");
  assert.equal(out?.summary, "worked through the backlog");
});

test("readReport truncates finalText to 500 characters", () => {
  const long = "x".repeat(900);
  const readReport = createReadReport(() => ({ status: "finished", finalText: long }));
  assert.equal(readReport("run_2")?.summary, "x".repeat(500));
});

test("readReport returns null (and still reads once) when no report exists", () => {
  let calls = 0;
  const readReport = createReadReport(() => {
    calls += 1;
    return null;
  });
  assert.equal(readReport("run_missing"), null);
  assert.equal(calls, 1);
});
