/**
 * s5: runs dying after answering with exit 137 + misleading
 * unrecognized_model.
 *
 * End-to-end through RuntimeManager (fake VM driver replays stream-json):
 *  - a run whose agent already produced its final result finishes with its
 *    cost even when the process is then reaped with SIGKILL;
 *  - a genuine signal kill is never failed over to the next provider, even
 *    when the stderr detail looks like a rate limit (429);
 *  - the benign unrecognized_model warning never reaches the run history.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager, type RunSummary } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { FAKE_CLAUDE_TRANSCRIPT_LINES } from "../vm/fake-claude";
import { Router } from "../providers/router";
import { telemetryBus } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess_s5",
  model: "clarke-1.0",
});

const UNRECOGNIZED_MODEL_STDERR =
  '[claude-code:unrecognized_model] {"model":"clarke-1.0","error":"model not recognized"}';

interface ClaudeBehavior {
  lines: string[];
  stderr?: string;
  exitCode: number;
}

class ScriptedDriver extends FakeVmDriver {
  calls: string[][] = [];

  constructor(private readonly behavior: (callIndex: number) => ClaudeBehavior) {
    super();
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    const index = this.calls.length;
    this.calls.push(cmd);
    const { lines, stderr, exitCode } = this.behavior(index);
    if (opts?.signal?.aborted) return { exitCode: 130 };
    for (const line of lines) opts?.onStdout?.(`${line}\n`);
    if (stderr !== undefined) opts?.onStderr?.(stderr);
    return { exitCode };
  }
}

function managerWith(driver: ScriptedDriver, router: Router | null): RuntimeManager {
  return new RuntimeManager({
    vm: new VmManager({ customDriver: driver }),
    router,
  });
}

async function waitFor(
  manager: RuntimeManager,
  userId: string,
  pred: (runs: RunSummary[]) => boolean,
  steps = 400,
): Promise<RunSummary[]> {
  for (let i = 0; i < steps; i++) {
    const runs = manager.list(userId);
    if (pred(runs)) return runs;
    await sleep(10);
  }
  throw new Error("timed out waiting for run state");
}

test("a run that answered before a 137 reap finishes with its cost", async () => {
  const driver = new ScriptedDriver(() => ({
    lines: [...FAKE_CLAUDE_TRANSCRIPT_LINES],
    stderr: `${UNRECOGNIZED_MODEL_STDERR}\n`,
    exitCode: 137,
  }));
  const manager = managerWith(driver, null);

  const started = manager.start("alice", { prompt: "Count from 1 to 200 slowly" });
  assert.equal(started.accepted, true);

  const events: unknown[] = [];
  telemetryBus.subscribe(started.runId, 0, (event) => events.push(event));

  const runs = await waitFor(manager, "alice", (all) =>
    all.some((run) => run.runId === started.runId && run.status !== "running" && run.status !== "queued"),
  );
  const run = runs.find((r) => r.runId === started.runId)!;
  assert.equal(run.status, "finished");
  assert.equal(run.costUsd, 0.001);
  assert.equal(run.error, undefined);

  const types = events.map((e) => (e as { type?: string }).type);
  assert.ok(types.includes("run.finished"), "run.finished should be emitted");
  assert.ok(!types.includes("run.error"), "no run.error for a run that already answered");
  for (const event of events) {
    assert.ok(!JSON.stringify(event).includes("unrecognized_model"), "benign warning must not surface");
  }
});

test("a signal kill never fails over, even when stderr looks like a 429", async () => {
  const router = new Router({
    providers: [
      { id: "p1", kind: "anthropic", keys: ["sk-p1"], rank: 0, models: { balanced: "m1" } },
      { id: "p2", kind: "anthropic", keys: ["sk-p2"], rank: 1, models: { balanced: "m2" } },
    ],
  });
  const driver = new ScriptedDriver((index) =>
    index === 0
      ? {
          lines: [INIT_LINE],
          stderr: `Error: HTTP 429 Too Many Requests\n${UNRECOGNIZED_MODEL_STDERR}\n`,
          exitCode: 137,
        }
      : { lines: [...FAKE_CLAUDE_TRANSCRIPT_LINES], exitCode: 0 },
  );
  const manager = managerWith(driver, router);

  const started = manager.start("bob", { prompt: "Count from 1 to 200 slowly" });
  assert.equal(started.accepted, true);

  const runs = await waitFor(manager, "bob", (all) =>
    all.some((run) => run.runId === started.runId && run.status !== "running" && run.status !== "queued"),
  );
  const run = runs.find((r) => r.runId === started.runId)!;
  assert.equal(run.status, "error");
  // The provider did not fail — the process was killed — so there must be
  // exactly one claude invocation, not a failover retry on p2.
  assert.equal(driver.calls.length, 1);
  assert.match(run.error ?? "", /137.*SIGKILL/i);
  assert.ok(!run.error?.includes("unrecognized_model"), "benign warning must not surface");
});
