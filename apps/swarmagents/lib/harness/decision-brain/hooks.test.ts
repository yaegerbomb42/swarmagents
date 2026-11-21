import test from "node:test";
import assert from "node:assert/strict";
import { DecisionBrainHooks, type BrainEvent } from "./hooks.js";
import { HeuristicDecisionRouter } from "./heuristic.js";
import { resolveDecisionBrainSettings } from "./settings.js";
import type { AgentSnapshot, DecisionResult, DecisionRouter } from "./types.js";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    goal: "Fix failing unit tests",
    lastToolCall: { name: "Bash", args: { command: "npm test" } },
    lastToolResult: { ok: true, output: "3 passing" },
    error: null,
    turnCount: 2,
    budgetLeft: { turnsRemaining: 10, tokensRemaining: 40_000 },
    ...overrides,
  };
}

function stubRouter(decision: DecisionResult["decision"]): DecisionRouter {
  return {
    decide: async () => ({
      decision,
      confidence: 0.9,
      reason: "stubbed decision",
      escalated: false,
    }),
  };
}

test("brain hooks: disabled by default, every decision proceeds", async () => {
  const hooks = new DecisionBrainHooks();
  assert.equal(hooks.settings.enabled, false);
  assert.deepEqual(await hooks.beforeTool(snapshot()), { action: "proceed" });
});

test("brain hooks: each decision maps to its verdict, verify proceeds recorded", async () => {
  const cases: Array<[DecisionResult["decision"], string]> = [
    ["continue", "proceed"],
    ["verify", "proceed"],
    ["ask", "ask"],
    ["stop", "stop"],
    ["retry", "retry"],
  ];
  for (const [decision, action] of cases) {
    const events: BrainEvent[] = [];
    const hooks = new DecisionBrainHooks({
      settings: { enabled: true },
      router: stubRouter(decision),
      emit: (e) => events.push(e),
    });
    const verdict = await hooks.beforeTool(snapshot());
    assert.equal(verdict.action, action, decision);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "brain.decision");
    if (events[0]!.type === "brain.decision") {
      assert.equal(events[0].decision, decision);
    }
  }
});

test("brain hooks: heuristic router asks on destructive calls, retries on errors, stops on budget", async () => {
  const hooks = new DecisionBrainHooks({
    settings: { enabled: true },
    router: new HeuristicDecisionRouter(),
  });
  const destructive = await hooks.beforeTool(
    snapshot({
      lastToolCall: { name: "Bash", args: { command: "rm -rf /tmp/build" } },
    }),
  );
  assert.equal(destructive.action, "ask");
  const failed = await hooks.beforeTool(snapshot({ error: "command not found" }));
  assert.equal(failed.action, "retry");
  const exhausted = await hooks.beforeTool(
    snapshot({ budgetLeft: { turnsRemaining: 0, tokensRemaining: 40_000 } }),
  );
  assert.equal(exhausted.action, "stop");
  const healthy = await hooks.beforeTool(snapshot());
  assert.deepEqual(healthy, { action: "proceed" });
});

test("brain hooks: a throwing or hanging router fails open and records the error", async () => {
  const events: BrainEvent[] = [];
  const throwing = new DecisionBrainHooks({
    settings: { enabled: true },
    router: {
      decide: async () => {
        throw new Error("scorer exploded");
      },
    },
    emit: (e) => events.push(e),
  });
  assert.deepEqual(await throwing.beforeTool(snapshot()), { action: "proceed" });
  assert.equal(throwing.failures, 1);
  assert.equal(events[0]!.type, "brain.error");

  const hanging = new DecisionBrainHooks({
    settings: { enabled: true, hookTimeoutMs: 20 },
    router: {
      decide: () => new Promise<DecisionResult>(() => {}),
    },
  });
  assert.deepEqual(await hanging.beforeTool(snapshot()), { action: "proceed" });
  assert.equal(hanging.failures, 1);
});

test("brain settings: invalid values fall back to defaults, never throw", () => {
  const resolved = resolveDecisionBrainSettings({
    enabled: "yes" as unknown as boolean,
    confidenceThreshold: 2,
    hookTimeoutMs: -5,
    maxTurns: 0,
  });
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.confidenceThreshold, 0.75);
  assert.equal(resolved.hookTimeoutMs, 1500);
  assert.equal(resolved.maxTurns, 50);
  assert.deepEqual(resolveDecisionBrainSettings({ enabled: true, maxTurns: 12 }), {
    enabled: true,
    confidenceThreshold: 0.75,
    hookTimeoutMs: 1500,
    maxTurns: 12,
  });
});
