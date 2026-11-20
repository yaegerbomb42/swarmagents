import test from "node:test";
import assert from "node:assert/strict";
import {
  clearTeamRuns,
  endTeamRun,
  hasActiveTeamRun,
  isTeamRunActive,
  latestTeamRun,
  listTeamRuns,
  ownsTeamRun,
  registerTeamRun,
} from "./store";
import type { TeamRun } from "./types";

function run(runId: string, createdAt: number): TeamRun {
  return {
    runId,
    userId: "alice",
    prompt: "do work",
    status: "running",
    createdAt,
    updatedAt: createdAt,
    plan: [],
    lanes: [],
    budget: { tokenCap: 1, tokensUsed: 0, costCapUsd: 1, costUsedUsd: 0 },
    concurrency: { limit: 1, active: 0 },
    mergedFiles: [],
    error: null,
  };
}

test.beforeEach(() => clearTeamRuns());

test("evicts the oldest inactive run, not an active one", () => {
  for (let i = 0; i < 25; i++) {
    const r = run(`old_${i}`, i);
    endTeamRun(r.runId);
    registerTeamRun(r);
  }
  const active = run("active", 100);
  registerTeamRun(active);

  assert.equal(isTeamRunActive("active"), true);
  assert.equal(ownsTeamRun("alice", "active"), true);
  assert.equal(hasActiveTeamRun("alice"), true);
  assert.equal(latestTeamRun("alice")?.runId, "active");
});

test("keeps every active run even when the cap is exceeded", () => {
  for (let i = 0; i < 30; i++) registerTeamRun(run(`live_${i}`, i));
  assert.equal(listTeamRuns("alice").length, 30);
  assert.equal(hasActiveTeamRun("alice"), true);
  assert.equal(isTeamRunActive("live_29"), true);
});