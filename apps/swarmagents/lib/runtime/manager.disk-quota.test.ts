import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";

/** 1 MiB string. */
function mib(n: number): string {
  return "x".repeat(1024 * 1024 * n);
}

/** Seed through the driver: VmManager.writeFile is quota-gated (VM-05). */
async function seed(driver: FakeVmDriver, userId: string, path: string, content: string) {
  const handle = await driver.ensure(userId);
  await driver.writeFile(handle, path, content);
}

function waitForTerminal(bus: TelemetryBus, runId: string): {
  events: SequencedEvent[];
  done: Promise<void>;
} {
  const events: SequencedEvent[] = [];
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  bus.subscribe(runId, 0, (event) => {
    events.push(event);
    if (event.type === "run.finished" || event.type === "run.error") finish();
  });
  return { events, done };
}

test("RuntimeManager refuses an agent run with run.error when over the disk quota", async () => {
  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver, quotas: { diskQuotaMb: 1 } });
  const bus = new TelemetryBus();
  const manager = new RuntimeManager({ vm, bus });

  // Fill the workspace past the 1 MB quota before starting the run.
  await seed(driver, "u-quota-agent", "/workspace/big.bin", mib(2));

  const { runId } = manager.start("u-quota-agent", { prompt: "hello" });
  const { events, done } = waitForTerminal(bus, runId);
  await done;

  const runError = events.find((event) => event.type === "run.error");
  assert.ok(runError, "expected a run.error event");
  const message = (runError as unknown as { message?: string }).message ?? "";
  assert.match(message, /exceeds the quota/i);

  const [summary] = manager.list("u-quota-agent");
  assert.equal(summary.status, "error");
  assert.match(summary.error ?? "", /exceeds the quota/i);
});

test("RuntimeManager starts runs normally while under the disk quota", async () => {
  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver, quotas: { diskQuotaMb: 10 } });
  const bus = new TelemetryBus();
  const manager = new RuntimeManager({ vm, bus });

  await vm.writeFile("u-quota-ok", "/workspace/small.bin", "hello");

  const { runId } = manager.start("u-quota-ok", { prompt: "hello" });
  const { events, done } = waitForTerminal(bus, runId);
  await done;

  assert.ok(events.some((event) => event.type === "run.finished"));
  assert.ok(!events.some((event) => event.type === "run.error"));
});

test("RuntimeManager refuses a shell exec with run.error when over the disk quota", async () => {
  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver, quotas: { diskQuotaMb: 1 } });
  const bus = new TelemetryBus();
  const manager = new RuntimeManager({ vm, bus });

  await seed(driver, "u-quota-shell", "/workspace/big.bin", mib(2));

  const { runId } = manager.execShell("u-quota-shell", ["echo", "hi"]);
  const { events, done } = waitForTerminal(bus, runId);
  await done;

  const runError = events.find((event) => event.type === "run.error");
  assert.ok(runError, "expected a run.error event");
  assert.ok(!events.some((event) => event.type === "shell.output"));
  const [summary] = manager.list("u-quota-shell");
  assert.equal(summary.status, "error");
  assert.equal(summary.kind, "shell");
});
