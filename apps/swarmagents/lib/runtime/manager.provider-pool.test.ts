import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRunProviderPoolEnabled } from "./manager";
import { RuntimeManager } from "./manager";
import { writeConfiguredProviders } from "../providers/store";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";

const BAD_KEY = "bad-provider-key-secret";
const GOOD_KEY = "good-provider-key-secret";
const HOST_KEY = "host-environment-key-must-not-be-used";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class KeyFailoverDriver extends FakeVmDriver {
  readonly keys: string[] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    const key = opts?.env?.ANTHROPIC_API_KEY ?? "";
    this.keys.push(key);
    if (key === BAD_KEY) {
      const line = "401 invalid api key";
      opts?.onStderr?.(`${line} ${key}\n`);
      return { exitCode: 1, stderr: `${line} ${key}` };
    }
    const lines = [
      { type: "system", subtype: "init", session_id: "sess_pool_ok", model: "claude-sonnet-4-5" },
      { type: "result", subtype: "success", session_id: "sess_pool_ok", cost_usd: 0, duration_ms: 1, num_turns: 1 },
    ];
    for (const line of lines) opts?.onStdout?.(`${JSON.stringify(line)}\n`);
    return { exitCode: 0 };
  }
}

async function runWithSetting(enabled: boolean) {
  const previousPool = process.env.SWARM_RUN_PROVIDER_POOL;
  const previousVerifier = process.env.SWARM_SHADOW_VERIFIER;
  const previousHome = process.env.SWARM_HOME;
  const previousHostKey = process.env.SWARM_KEYS_ANTHROPIC;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-manager-pool-"));
  const userId = `pool-${enabled}`;
  if (enabled) process.env.SWARM_RUN_PROVIDER_POOL = "1";
  else delete process.env.SWARM_RUN_PROVIDER_POOL;
  process.env.SWARM_SHADOW_VERIFIER = "0";
  process.env.SWARM_HOME = home;
  process.env.SWARM_KEYS_ANTHROPIC = HOST_KEY;
  try {
    writeConfiguredProviders(userId, [
      { id: "anthropic-test", kind: "anthropic", rank: 0, enabled: true, keys: [BAD_KEY, GOOD_KEY] },
    ]);
    const driver = new KeyFailoverDriver();
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
    if (previousHome === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = previousHome;
    if (previousHostKey === undefined) delete process.env.SWARM_KEYS_ANTHROPIC;
    else process.env.SWARM_KEYS_ANTHROPIC = previousHostKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("run-level provider pool setting is opt-in", () => {
  assert.equal(isRunProviderPoolEnabled({}), false);
  assert.equal(isRunProviderPoolEnabled({ SWARM_RUN_PROVIDER_POOL: "0" }), false);
  assert.equal(isRunProviderPoolEnabled({ SWARM_RUN_PROVIDER_POOL: "true" }), true);
});

test("enabled run pool rotates a dead user key and keeps key material out of telemetry", async () => {
  const { driver, events, run } = await runWithSetting(true);
  assert.equal(run.status, "finished");
  assert.deepEqual(driver.keys, [BAD_KEY, GOOD_KEY]);
  assert.ok(events.some((event) => event.type === "provider.pool"));
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(BAD_KEY), false);
  assert.equal(serialized.includes(GOOD_KEY), false);
});

test("disabled run pool preserves the existing single-key failure path", async () => {
  const { driver, events, run } = await runWithSetting(false);
  assert.equal(run.status, "error");
  assert.deepEqual(driver.keys, [BAD_KEY]);
  assert.equal(events.some((event) => event.type === "provider.pool"), false);
});
