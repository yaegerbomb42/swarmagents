/**
 * budget-gate.test.ts — the per-run budget ledger and the "budget reached,
 * continue?" gate.
 *
 * The gate is what lets a run pause at its cap instead of dying: it tracks
 * what a run has spent, holds the request that hit the cap, and remembers that
 * the user chose to continue (which lifts the cap for the rest of that run).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// The production watchdogs are intentionally unref'ed so they do not keep a
// server alive on their own. Keep the test process alive while each test is
// awaiting one; otherwise node:test cancels the pending promise on idle.
let keepAlive: ReturnType<typeof setInterval>;
test.beforeEach(() => { keepAlive = setInterval(() => {}, 60_000); });
test.afterEach(() => clearInterval(keepAlive));

import { BudgetGate, setBudgetGateForTesting, getBudgetGate } from "./budget-gate";

test("the ledger tracks a run's spend and its expected next call", () => {
  const gate = new BudgetGate();
  assert.equal(gate.spendFor("run_1"), 0);
  assert.equal(gate.known("run_1"), false);

  gate.noteSpend("run_1", 0.002);
  gate.noteSpend("run_1", 0.004);
  assert.equal(gate.spendFor("run_1"), 0.006);
  assert.equal(gate.known("run_1"), true);
  // The mean cost of the run's priced calls.
  assert.equal(gate.expectedNextCallUsd("run_1"), 0.003);

  // A free call costs nothing and does not count as a priced call.
  gate.noteSpend("run_1", 0);
  assert.equal(gate.spendFor("run_1"), 0.006);
  assert.equal(gate.expectedNextCallUsd("run_1"), 0.003);

  // Runs are tracked separately.
  assert.equal(gate.spendFor("run_2"), 0);
});

test("seedSpend restores a run's spend after a restart", () => {
  const gate = new BudgetGate();
  gate.seedSpend("run_1", 0.01, 2);
  assert.equal(gate.spendFor("run_1"), 0.01);
  assert.equal(gate.expectedNextCallUsd("run_1"), 0.005);

  // A negative or broken value is treated as no spend.
  gate.seedSpend("run_2", -5);
  assert.equal(gate.spendFor("run_2"), 0);
});

test("a held run waits for the user and resumes on continue", async () => {
  const gate = new BudgetGate({ ttlMs: 5_000 });
  const held = gate.hold("run_1", "alice", {
    spentUsd: 0.12,
    limitUsd: 0.1,
    projectedUsd: 0.13,
    expectedNextCallUsd: 0.01,
  });

  const pending = gate.pendingFor("run_1");
  assert.ok(pending);
  assert.equal(pending.status, "pending");
  assert.equal(pending.runId, "run_1");
  assert.equal(pending.userId, "alice");
  assert.equal(pending.spentUsd, 0.12);
  assert.equal(pending.limitUsd, 0.1);
  assert.equal(pending.projectedUsd, 0.13);
  assert.equal(pending.expiresAt - pending.createdAt, 5_000);

  assert.equal(gate.resolve("run_1", "continue"), true);
  assert.equal(await held, "continue");
  assert.equal(gate.pendingFor("run_1")!.status, "continued");
  // "Continue" lifts the cap for the rest of the run.
  assert.equal(gate.isExempt("run_1"), true);
  assert.equal(gate.isExempt("run_2"), false);
});

test("a held run stops when the user refuses", async () => {
  const gate = new BudgetGate({ ttlMs: 5_000 });
  const held = gate.hold("run_1", "alice", {
    spentUsd: 0.12,
    limitUsd: 0.1,
    projectedUsd: 0.13,
    expectedNextCallUsd: 0.01,
  });

  assert.equal(gate.resolve("run_1", "stop"), true);
  assert.equal(await held, "stop");
  assert.equal(gate.pendingFor("run_1")!.status, "stopped");
  assert.equal(gate.isExempt("run_1"), false);
});

test("a second hold on the same run joins the pending decision", async () => {
  const gate = new BudgetGate({ ttlMs: 5_000 });
  const first = gate.hold("run_1", "alice", {
    spentUsd: 0.12,
    limitUsd: 0.1,
    projectedUsd: 0.13,
    expectedNextCallUsd: 0.01,
  });
  const second = gate.hold("run_1", "alice", {
    spentUsd: 0.12,
    limitUsd: 0.1,
    projectedUsd: 0.13,
    expectedNextCallUsd: 0.01,
  });
  assert.equal(gate.pendingFor("run_1")!.id, gate.pendingFor("run_1")!.id);

  gate.resolve("run_1", "continue");
  assert.equal(await first, "continue");
  assert.equal(await second, "continue");
});

test("an unanswered decision expires and stops the run", async () => {
  const gate = new BudgetGate({ ttlMs: 20 });
  const held = gate.hold("run_1", "alice", {
    spentUsd: 0.12,
    limitUsd: 0.1,
    projectedUsd: 0.13,
    expectedNextCallUsd: 0.01,
  });
  assert.equal(await held, "stop");
  assert.equal(gate.pendingFor("run_1")!.status, "expired");
  assert.equal(gate.isExempt("run_1"), false);
});

test("releasing a run drops its pending decision", async () => {
  const gate = new BudgetGate({ ttlMs: 5_000 });
  const held = gate.hold("run_1", "alice", {
    spentUsd: 0.12,
    limitUsd: 0.1,
    projectedUsd: 0.13,
    expectedNextCallUsd: 0.01,
  });
  gate.release("run_1");
  assert.equal(await held, "stop");
  assert.equal(gate.pendingFor("run_1"), undefined);
});

test("the warning is published once per run", () => {
  const gate = new BudgetGate();
  assert.equal(gate.hasWarned("run_1"), false);
  gate.markWarned("run_1");
  assert.equal(gate.hasWarned("run_1"), true);
  assert.equal(gate.hasWarned("run_2"), false);
});

test("resolving a decision that is not pending is refused", () => {
  const gate = new BudgetGate({ ttlMs: 5_000 });
  assert.equal(gate.resolve("run_1", "continue"), false);
  gate.hold("run_1", "alice", {
    spentUsd: 0.12,
    limitUsd: 0.1,
    projectedUsd: 0.13,
    expectedNextCallUsd: 0.01,
  });
  assert.equal(gate.resolve("run_1", "continue"), true);
  // The first verdict wins.
  assert.equal(gate.resolve("run_1", "stop"), false);
  assert.equal(gate.pendingFor("run_1")!.status, "continued");
});

test("the process-wide gate can be swapped for tests", () => {
  const original = getBudgetGate();
  const replacement = new BudgetGate();
  setBudgetGateForTesting(replacement);
  assert.equal(getBudgetGate(), replacement);
  setBudgetGateForTesting(null);
  assert.notEqual(getBudgetGate(), replacement);
  assert.ok(getBudgetGate());
  void original;
});
