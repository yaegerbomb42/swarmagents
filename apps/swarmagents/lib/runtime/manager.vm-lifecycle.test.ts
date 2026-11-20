import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_vm_lifecycle", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_vm_lifecycle", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

class LifecycleFakeVm extends FakeVmDriver {
  ensures = 0;

  constructor(private readonly options: { delayMs?: number; fail?: Error } = {}) {
    super();
  }

  override async ensure(userId: string): Promise<VmHandle> {
    this.ensures += 1;
    if (this.options.delayMs) await sleep(this.options.delayMs);
    if (this.options.fail) throw this.options.fail;
    return super.ensure(userId);
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") {
      for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
      return { exitCode: 0 };
    }
    return super.exec(handle, cmd, opts);
  }
}

function setup(driver: LifecycleFakeVm, userId: string) {
  const bus = new TelemetryBus();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), bus });
  const { runId } = manager.start(userId, { prompt: "hello", sessionId: "sess_vm_lifecycle" });

  const events: SequencedEvent[] = [];
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  bus.subscribe(runId, 0, (event) => {
    events.push(event);
    if (event.type === "run.finished" || event.type === "run.error") finish();
  });

  return { bus, manager, runId, events, done };
}

test("RuntimeManager publishes vm.starting and vm.ready around VmManager.ensure", async () => {
  const driver = new LifecycleFakeVm({ delayMs: 25 });
  const { events, done, runId } = setup(driver, "u-vm-lifecycle-ok");
  await done;

  const types = events.filter((event) => event.type !== "run.mode").map((event) => event.type);
  assert.equal(types[0], "run.created");
  assert.equal(types[1], "vm.starting");
  assert.equal(types[2], "vm.ready");
  assert.equal(types[3], "run.started");
  assert.equal(types[types.length - 1], "run.finished");

  const mode = events.find((event) => event.type === "run.mode");
  assert.ok(mode, "expected a run.mode event");
  assert.ok(["gui", "text", "chat"].includes(String((mode.data as { mode?: string }).mode)));

  const ready = events.find((event) => event.type === "vm.ready")!;
  assert.equal(ready.runId, runId);
  const data = ready.data as { ms: number; durationMs: number };
  assert.equal(typeof data.ms, "number");
  assert.equal(data.ms, data.durationMs);
  assert.ok(data.ms >= 15, `expected measured boot time, got ${data.ms}ms`);
  assert.equal(driver.ensures, 1);
});

test("RuntimeManager emits a redacted vm.error when ensure fails", async () => {
  const secret = "swarm-super-secret-token-value";
  const apiKey = "sk-ant-api03-SECRETKEY1234567890";
  process.env.SWARM_TEST_TOKEN = secret;
  try {
    const driver = new LifecycleFakeVm({ fail: new Error(`docker unavailable: ${secret} (${apiKey})`) });
    const { manager, events, done, runId } = setup(driver, "u-vm-lifecycle-fail");
    await done;

    const types = events.map((event) => event.type);
    assert.ok(types.includes("vm.starting"));
    assert.ok(types.includes("vm.error"));
    assert.ok(!types.includes("vm.ready"));
    assert.equal(driver.ensures, 1);

    const vmError = events.find((event) => event.type === "vm.error");
    assert.ok(vmError);
    const message = (vmError.data as { message: string }).message;
    assert.ok(!message.includes(secret));
    assert.ok(!message.includes(apiKey));
    assert.match(message, /\[REDACTED\]/);

    const runError = events.find((event) => event.type === "run.error") as (SequencedEvent & { message?: string }) | undefined;
    assert.equal(runError?.message, message);

    const [summary] = manager.list("u-vm-lifecycle-fail");
    assert.equal(summary.runId, runId);
    assert.equal(summary.status, "error");
    assert.equal(summary.error, message);
  } finally {
    delete process.env.SWARM_TEST_TOKEN;
  }
});