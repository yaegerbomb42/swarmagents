import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager } from "./manager";
import { writeConfiguredProviders } from "../providers/store";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";

const GOOD_KEY = "good-provider-key-secret";
const HOST_KEY = "host-environment-key-must-not-be-used";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A driver that hits the max-turns ceiling on the first claude invocation and
 * succeeds on the follow-up. The first run's `result` subtype
 * `error_max_turns` is what the runner maps to the `run.finished` reason
 * `"max_turns"`, which should trigger auto-continuation.
 */
class MaxTurnsThenSuccessDriver extends FakeVmDriver {
  runs = 0;

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (!cmd[0].endsWith("/claude") && cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.runs += 1;
    const sessionId = `sess_cont_${this.runs}`;
    const lines: object[] = [{ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-4-5" }];
    if (this.runs === 1) {
      lines.push({
        type: "result",
        subtype: "error_max_turns",
        session_id: sessionId,
        num_turns: 200,
        cost_usd: 0.05,
        duration_ms: 500,
        result: "Reached the turn ceiling",
      });
    } else {
      lines.push({
        type: "result",
        subtype: "success",
        session_id: sessionId,
        cost_usd: 0.01,
        num_turns: 3,
        duration_ms: 100,
        result: "done",
      });
    }
    for (const line of lines) opts?.onStdout?.(`${JSON.stringify(line)}\n`);
    return { exitCode: 0 };
  }
}

async function runMaxTurnsContinuation() {
  const previousPool = process.env.SWARM_RUN_PROVIDER_POOL;
  const previousVerifier = process.env.SWARM_SHADOW_VERIFIER;
  const previousAutoContinue = process.env.SWARM_AUTO_CONTINUE;
  const previousHome = process.env.SWARM_HOME;
  const previousHostKey = process.env.SWARM_KEYS_ANTHROPIC;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-manager-continuation-"));
  const userId = "continuation-user";
  process.env.SWARM_RUN_PROVIDER_POOL = "1";
  process.env.SWARM_SHADOW_VERIFIER = "0";
  process.env.SWARM_AUTO_CONTINUE = "1";
  process.env.SWARM_HOME = home;
  process.env.SWARM_KEYS_ANTHROPIC = HOST_KEY;
  try {
    writeConfiguredProviders(userId, [
      { id: "anthropic-test", kind: "anthropic", rank: 0, enabled: true, keys: [GOOD_KEY] },
    ]);
    const driver = new MaxTurnsThenSuccessDriver();
    const bus = new TelemetryBus();
    const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), bus });
    const { runId } = manager.start(userId, { prompt: "hello" });
    const events: SequencedEvent[] = [];
    bus.subscribe(runId, 0, (event) => events.push(event));
    for (let i = 0; i < 200; i++) {
      const run = manager.list(userId).find((item) => item.runId === runId);
      if (run?.status === "finished" || run?.status === "error") return { driver, events, run };
      await sleep(10);
    }
    throw new Error("run did not finish");
  } finally {
    if (previousPool === undefined) delete process.env.SWARM_RUN_PROVIDER_POOL;
    else process.env.SWARM_RUN_PROVIDER_POOL = previousPool;
    if (previousVerifier === undefined) delete process.env.SWARM_SHADOW_VERIFIER;
    else process.env.SWARM_SHADOW_VERIFIER = previousVerifier;
    if (previousAutoContinue === undefined) delete process.env.SWARM_AUTO_CONTINUE;
    else process.env.SWARM_AUTO_CONTINUE = previousAutoContinue;
    if (previousHome === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = previousHome;
    if (previousHostKey === undefined) delete process.env.SWARM_KEYS_ANTHROPIC;
    else process.env.SWARM_KEYS_ANTHROPIC = previousHostKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("max-turns with autoContinue triggers a clean continuation phase", async () => {
  const { driver, events, run } = await runMaxTurnsContinuation();
  assert.equal(run.status, "finished");
  assert.ok(driver.runs >= 2, "the run should have been resumed after max turns");
  assert.ok(events.some((event) => event.type === "run.continued"), "run.continued telemetry must be emitted");
});
