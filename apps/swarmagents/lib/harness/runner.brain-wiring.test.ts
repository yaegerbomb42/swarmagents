/**
 * Per-run Decision Brain wiring tests.
 *
 * runner.test.ts covers the constructor-option path (heuristic halt, stub
 * retry/ask, brain-off byte-identical). This file covers the production
 * path added by the wiring bundle: `decisionBrain` on the RunRequest —
 * the runtime passes the user's saved settings plus a telemetry sink
 * there — including request-wins-over-constructor, fail-open on throw and
 * on timeout, and the brain.decision / brain.error events the sink sees.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeRunner } from "./runner.js";
import type { BrainEvent, DecisionRouter } from "./decision-brain/index.js";
import type { RunRequest, TelemetryEvent, VmExec, VmExecOpts } from "./types.js";

class ScriptedVm implements VmExec {
  calls: Array<{ cmd: string[]; opts: VmExecOpts }> = [];

  constructor(private readonly chunks: string[]) {}

  async exec(cmd: string[], opts?: VmExecOpts): Promise<{ exitCode: number }> {
    this.calls.push({ cmd, opts: opts ?? {} });
    for (const chunk of this.chunks) opts?.onStdout?.(chunk);
    return { exitCode: opts?.signal?.aborted ? 130 : 0 };
  }
}

const INIT = {
  type: "system",
  subtype: "init",
  cwd: "/home/user",
  session_id: "sess_brain_wire_1",
  model: "claude-sonnet-5-5",
};

const RESULT = {
  type: "result",
  subtype: "success",
  duration_ms: 100,
  num_turns: 1,
  result: "Done.",
  session_id: "sess_brain_wire_1",
  cost_usd: 0.001,
};

function fixture(toolUse: Record<string, unknown>): string {
  const call = {
    type: "assistant",
    message: { id: "w1", content: [{ type: "tool_use", id: "toolu_w1", ...toolUse }] },
  };
  return [INIT, call, RESULT].map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const ENV = { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" };

async function runWith(
  runner: ClaudeCodeRunner,
  request: Partial<RunRequest> & { fixtureText: string },
): Promise<{ events: TelemetryEvent[]; outcome: Awaited<ReturnType<ClaudeCodeRunner["run"]>> }> {
  const { fixtureText, ...rest } = request;
  const vm = new ScriptedVm([fixtureText]);
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run(
    { prompt: "Inspect repo", env: ENV, ...rest, vm },
    (e) => events.push(e),
  );
  return { events, outcome };
}

test("per-run brain on + heuristic: destructive command halts, decision reaches the sink", async () => {
  const brainEvents: BrainEvent[] = [];
  const { events, outcome } = await runWith(new ClaudeCodeRunner(), {
    fixtureText: fixture({ name: "Bash", input: { command: "rm -rf build" } }),
    decisionBrain: {
      settings: { enabled: true },
      emit: (e: BrainEvent) => brainEvents.push(e),
    },
  });
  assert.equal(outcome.exitCode, 0);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /Halted by harness risk policy: high-stakes:destructive-pattern/);
  assert.equal(brainEvents.length, 1);
  const decision = brainEvents[0]!;
  assert.equal(decision.type, "brain.decision");
  if (decision.type === "brain.decision") {
    assert.equal(decision.decision, "ask");
    assert.equal(decision.confidence, 1);
    assert.match(decision.reason, /high-stakes:destructive-pattern/);
    assert.equal(typeof decision.latencyMs, "number");
    assert.ok(decision.latencyMs >= 0);
  }
});

test("per-run brain off wins over an enabled constructor option", async () => {
  // Constructor would halt on the destructive command; the per-run
  // override disables the brain, so the run must be untouched.
  const brainEvents: BrainEvent[] = [];
  const { events, outcome } = await runWith(
    new ClaudeCodeRunner({ decisionBrain: { settings: { enabled: true } } }),
    {
      fixtureText: fixture({ name: "Bash", input: { command: "rm -rf build" } }),
      decisionBrain: {
        settings: { enabled: false },
        emit: (e: BrainEvent) => brainEvents.push(e),
      },
    },
  );
  assert.equal(outcome.exitCode, 0);
  assert.equal(events.some((e) => e.type === "run.error"), false, "no halt");
  assert.equal(events.some((e) => e.type === "tool.blocked"), false, "no block");
  assert.equal(brainEvents.length, 0, "brain never evaluated");
});

test("per-run brain on + throwing router: fail-open, run completes, brain.error emitted", async () => {
  const throwingRouter: DecisionRouter = {
    decide: async () => {
      throw new Error("router exploded");
    },
  };
  const brainEvents: BrainEvent[] = [];
  const { events, outcome } = await runWith(new ClaudeCodeRunner(), {
    fixtureText: fixture({ name: "Bash", input: { command: "ls -la" } }),
    decisionBrain: {
      settings: { enabled: true },
      router: throwingRouter,
      emit: (e: BrainEvent) => brainEvents.push(e),
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(events.some((e) => e.type === "run.error"), false, "a brain failure never halts");
  assert.equal(events.some((e) => e.type === "tool.blocked"), false);
  assert.ok(events.some((e) => e.type === "run.finished"), "the run carried on");
  assert.equal(brainEvents.length, 1);
  const err = brainEvents[0]!;
  assert.equal(err.type, "brain.error");
  if (err.type === "brain.error") assert.match(err.message, /router exploded/);
});

test("per-run brain on + slow router: hook timeout fails open, brain.error emitted", async () => {
  const slowRouter: DecisionRouter = {
    decide: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { decision: "stop", confidence: 1, reason: "too slow to matter", escalated: false };
    },
  };
  const brainEvents: BrainEvent[] = [];
  const started = Date.now();
  const { events, outcome } = await runWith(new ClaudeCodeRunner(), {
    fixtureText: fixture({ name: "Bash", input: { command: "ls -la" } }),
    decisionBrain: {
      settings: { enabled: true, hookTimeoutMs: 20 },
      router: slowRouter,
      emit: (e: BrainEvent) => brainEvents.push(e),
    },
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.exitCode, 0);
  assert.equal(events.some((e) => e.type === "run.error"), false, "the late stop verdict is discarded");
  assert.ok(events.some((e) => e.type === "run.finished"));
  assert.equal(brainEvents.length, 1);
  const err = brainEvents[0]!;
  assert.equal(err.type, "brain.error");
  if (err.type === "brain.error") assert.match(err.message, /decision brain timeout after 20ms/);
  assert.ok(elapsed < 250, `run did not wait for the slow router (${elapsed}ms)`);
});

test("per-run brain on + stub stop router: halts with the brain's reason", async () => {
  const stopRouter: DecisionRouter = {
    decide: async () => ({
      decision: "stop",
      confidence: 0.9,
      reason: "turn budget exhausted",
      escalated: false,
    }),
  };
  const { events } = await runWith(new ClaudeCodeRunner(), {
    fixtureText: fixture({ name: "Bash", input: { command: "ls -la" } }),
    decisionBrain: { settings: { enabled: true }, router: stopRouter },
  });
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /turn budget exhausted/);
  assert.ok(events.some((e) => e.type === "tool.blocked"), "halt is visible on the stream");
});

test("per-run brain absent: argv and events match a runner with no brain at all", async () => {
  const plain = await runWith(new ClaudeCodeRunner(), {
    fixtureText: fixture({ name: "Bash", input: { command: "ls -la" } }),
  });
  const withEmpty = await runWith(new ClaudeCodeRunner(), {
    fixtureText: fixture({ name: "Bash", input: { command: "ls -la" } }),
    decisionBrain: {},
  });
  assert.equal(withEmpty.outcome.exitCode, 0);
  const withoutWallClock = (events: TelemetryEvent[]) =>
    events.map((event) => {
      const copy = { ...(event as unknown as Record<string, unknown>) };
      delete copy.startedAt;
      delete copy.finishedAt;
      return copy;
    });
  assert.deepEqual(withoutWallClock(withEmpty.events), withoutWallClock(plain.events));
});
