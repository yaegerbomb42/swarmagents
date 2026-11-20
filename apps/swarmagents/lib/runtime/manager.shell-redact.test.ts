import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";

// Fake key-shaped secret — never real material — planted in a shell command.
const FAKE_SECRET = "sk-FAKE-PLANTED-SECRET-0123456789";

async function withShellLog(body: (dir: string, runId: string) => Promise<void>): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b6-shell-redact-"));
  try {
    const driver = new FakeVmDriver();
    const vm = new VmManager({ customDriver: driver });
    // Persist events to a real temp dir so we can inspect the durable log.
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    const manager = new RuntimeManager({ vm, bus });

    const { runId } = manager.execShell(
      "u-plant",
      ["sh", "-c", "echo hello"],
      `deploy to staging with ${FAKE_SECRET}`,
    );

    // Wait for the shell to reach a terminal event so the bus is quiescent.
    const finished = new Promise<void>((resolve) => {
      const unsub = bus.subscribe(runId, 0, (event: SequencedEvent) => {
        if (event.type === "run.finished" || event.type === "run.error") {
          unsub();
          resolve();
        }
      });
    });
    await Promise.race([finished, new Promise((r) => setTimeout(r, 5000))]);

    await body(dir, runId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a planted secret in a shell command is redacted in the persisted run log", async () => {
  await withShellLog(async (_dir, runId) => {
    const content = fs.readFileSync(path.join(_dir, `${runId}.jsonl`), "utf8");
    assert.ok(
      !content.includes(FAKE_SECRET),
      "planted secret must never land in the persisted run log",
    );
    assert.ok(
      content.includes("[REDACTED]"),
      "redacted marker must replace the secret in the shell.cmd event",
    );
  });
});