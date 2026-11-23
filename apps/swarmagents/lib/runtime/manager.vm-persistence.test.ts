import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";
import { configureProviderStorePaths } from "../providers/store";
import { writeUserSettings, type VmPersistenceMode } from "../providers/settings";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_vm_persist", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_vm_persist", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

class CountingFakeVm extends FakeVmDriver {
  resets = 0;
  stops = 0;

  override async reset(handle: VmHandle): Promise<void> {
    this.resets += 1;
    return super.reset(handle);
  }

  override async stop(handle: VmHandle): Promise<void> {
    this.stops += 1;
    return super.stop(handle);
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") {
      for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
      return { exitCode: 0 };
    }
    return super.exec(handle, cmd, opts);
  }
}

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-vm-persist-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function runOnce(driver: CountingFakeVm, userId: string): Promise<SequencedEvent[]> {
  const bus = new TelemetryBus();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), bus });
  const { runId } = manager.start(userId, { prompt: "hello" });

  const events: SequencedEvent[] = [];
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  bus.subscribe(runId, 0, (event) => {
    events.push(event);
    if (event.type === "run.finished" || event.type === "run.error") finish();
  });
  await done;
  return events;
}

function setMode(userId: string, mode: VmPersistenceMode): void {
  writeUserSettings(userId, { preferFreeProviders: true, vmPersistenceMode: mode });
}

test("fresh-per-task resets the VM before the run starts", async () => {
  const driver = new CountingFakeVm();
  const userId = "u-vm-persist-fresh";
  setMode(userId, "fresh-per-task");
  const events = await runOnce(driver, userId);
  assert.equal(events[events.length - 1]?.type, "run.finished");
  assert.equal(driver.resets, 1);
  assert.equal(driver.stops, 0);
});

test("persistent (default) neither resets nor stops the VM", async () => {
  const driver = new CountingFakeVm();
  const events = await runOnce(driver, "u-vm-persist-default");
  assert.equal(events[events.length - 1]?.type, "run.finished");
  assert.equal(driver.resets, 0);
  assert.equal(driver.stops, 0);
});

test("terminate-at-project-end stops the VM when the last run finishes", async () => {
  const driver = new CountingFakeVm();
  const userId = "u-vm-persist-terminate";
  setMode(userId, "terminate-at-project-end");
  const events = await runOnce(driver, userId);
  assert.equal(events[events.length - 1]?.type, "run.finished");
  assert.equal(driver.resets, 0);
  // The stop is fire-and-forget from finalize; give it a moment to land.
  for (let i = 0; i < 50 && driver.stops === 0; i += 1) await sleep(20);
  assert.equal(driver.stops, 1);
});
