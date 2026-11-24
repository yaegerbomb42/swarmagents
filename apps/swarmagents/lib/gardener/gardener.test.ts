import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskDifficulty } from "../mcp-types";
import { fitsDifficulty, tasksWithinDifficulty } from "./difficulty";
import { hasSurplusQuota } from "./quota";
import { proposalsFromAnalysis } from "./proposals";
import { configureGardenerDir, loadGardener, readUserGardener, setProposalStatus, updateUserGardener } from "./store";
import { decideAutopilotTick } from "./tick";
import { inAutopilotWindow } from "./window";

const idleMs = 30 * 60_000;

test("autopilot window is the pre-hibernate gap only", () => {
  assert.equal(inAutopilotWindow({ enabled: true, idleMs, idleForMs: 0, activeExec: false }).ok, false);
  assert.equal(inAutopilotWindow({ enabled: true, idleMs, idleForMs: 60_000, activeExec: true }).ok, false);
  assert.equal(inAutopilotWindow({ enabled: false, idleMs, idleForMs: 60_000, activeExec: false }).ok, false);
  assert.equal(inAutopilotWindow({ enabled: true, idleMs, idleForMs: idleMs, activeExec: false }).reason, "past hibernate threshold");
  assert.equal(inAutopilotWindow({ enabled: true, idleMs, idleForMs: idleMs - 1, activeExec: false }).ok, true);
  assert.equal(inAutopilotWindow({ enabled: true, idleMs: 0, idleForMs: 1, activeExec: false }).reason, "hibernate disabled");
});

test("surplus quota accepts free and loopback providers only", () => {
  assert.equal(hasSurplusQuota([{ id: "paid", isFree: false }]).ok, false);
  assert.equal(hasSurplusQuota([{ id: "ollama", baseUrl: "http://127.0.0.1:11434" }]).providerId, "ollama");
  assert.equal(
    hasSurplusQuota([{ id: "free", isFree: true, dailyBudgetUsd: 1, spentTodayUsd: 1 }]).ok,
    false,
  );
  const now = 1_000;
  assert.equal(
    hasSurplusQuota([{ id: "free", isFree: true, quotaExhaustedUntil: now + 1 }], now).ok,
    false,
  );
  assert.equal(hasSurplusQuota([{ id: "free", isFree: true, enabled: false }]).ok, false);
});

test("board poll keeps tasks at or below the max difficulty, easiest first", () => {
  const tasks: { id: string; status: string; difficulty: TaskDifficulty; title: string }[] = [
    { id: "low", status: "open", difficulty: "easy", title: "a" },
    { id: "mid", status: "open", difficulty: "medium", title: "b" },
    { id: "high", status: "open", difficulty: "hard", title: "c" },
    { id: "done", status: "completed", difficulty: "medium", title: "d" },
  ];
  assert.equal(fitsDifficulty("hard", "medium"), false);
  assert.equal(fitsDifficulty("easy", "medium"), true);
  assert.equal(fitsDifficulty("medium", "medium"), true);
  const matched = tasksWithinDifficulty(tasks, "medium");
  assert.deepEqual(matched.map((t) => t.id), ["low", "mid"]);
});

test("analysis proposes missing tests and a hotspot PR awaiting approval", () => {
  const proposals = proposalsFromAnalysis({
    userId: "local",
    repoRoot: "/repo",
    now: 10,
    existing: [],
    hotspots: [
      { path: "src/a.ts", heat: 3, coveragePct: 10 },
      { path: "src/b.ts", heat: 1, coveragePct: 90 },
      { path: "src/c.ts", heat: 2, coveragePct: null },
    ],
  });
  assert.equal(proposals.filter((p) => p.kind === "unit-test").length, 2);
  assert.equal(proposals.filter((p) => p.kind === "pr").length, 1);
  assert.ok(proposals.every((p) => p.status === "awaiting_approval"));
  const again = proposalsFromAnalysis({
    userId: "local",
    repoRoot: "/repo",
    now: 11,
    existing: proposals,
    hotspots: [{ path: "src/a.ts", heat: 3, coveragePct: 10 }],
  });
  assert.equal(again.length, 0);
});

test("tick refuses work outside the window and queues when quota is surplus", () => {
  const base = {
    userId: "local",
    now: 50,
    enabled: true,
    idleMs,
    idleForMs: 5 * 60_000,
    activeExec: false,
    providers: [{ id: "free", isFree: true }],
    maxDifficulty: "medium" as TaskDifficulty,
    tasks: [{ id: "t1", title: "Fix parser", status: "open", difficulty: "medium" as TaskDifficulty, description: "edge cases" }],
    hotspotsByRepo: { "/repo": [{ path: "lib/x.ts", heat: 4, coveragePct: 0 }] },
  };
  const idle = decideAutopilotTick({ ...base, idleForMs: 0 }, []);
  assert.equal(idle.result.ran, false);
  const paid = decideAutopilotTick({ ...base, providers: [{ id: "paid" }] }, []);
  assert.equal(paid.result.ran, false);
  const ok = decideAutopilotTick(base, []);
  assert.equal(ok.result.ran, true);
  assert.equal(ok.result.added, 3);
  assert.ok(ok.proposals.some((p) => p.kind === "board-task" && p.taskId === "t1"));
});

test("approval is one status flip and persists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-"));
  configureGardenerDir(dir);
  updateUserGardener("local", (state) => {
    state.enabled = true;
    state.proposals.push({
      id: "p1",
      userId: "local",
      kind: "pr",
      title: "Review",
      summary: "wait",
      status: "awaiting_approval",
      createdAt: 1,
    });
  });
  const approved = setProposalStatus("local", "p1", "approved");
  assert.equal(approved?.status, "approved");
  assert.equal(readUserGardener("local").proposals[0].status, "approved");
  assert.equal(readUserGardener("local").enabled, true);
  configureGardenerDir(null);
});

test("a corrupt gardener.json falls back to empty state instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-corrupt-"));
  configureGardenerDir(dir);
  try {
    fs.writeFileSync(path.join(dir, "gardener.json"), "{not json");
    assert.deepEqual(loadGardener(), { version: 1, users: {} });
    assert.deepEqual(readUserGardener("local"), { enabled: false, maxDifficulty: "medium", pinned: [], proposals: [] });
  } finally {
    configureGardenerDir(null);
  }
});
