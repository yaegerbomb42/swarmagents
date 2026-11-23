/**
 * FIX-19: global concurrent-VM cap (SWARM_MAX_CONCURRENT_VMS, default 4).
 *
 * A run that would need a fresh VM past the cap queues with a capacity
 * status (limit / inUse / waiting) instead of starting a container or
 * OOMing the host. Idle-but-alive VMs count until the idle sweeper
 * hibernates them (or they are stopped/reset); a user whose VM is already
 * live is never blocked by other users' VMs. Queued runs start oldest
 * first as slots free. Per-user limits (one active run, SWARM_MAX_QUEUED)
 * are unchanged.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { telemetryBus } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../vm/types";
import type { RunSummary } from "./manager";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_cap", model: "claude-test" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_cap", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

/** Fake driver whose claude execs sleep when the prompt says "slow". */
class PromptDelayVm extends FakeVmDriver {
  calls: string[][] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.calls.push(cmd);
    const prompt = cmd.at(-1) ?? "";
    if (prompt.includes("slow")) await sleep(600);
    if (opts?.signal?.aborted) return { exitCode: 130 };
    for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
    return { exitCode: 0 };
  }

  prompts(): string[] {
    return this.calls.map((cmd) => cmd.at(-1) ?? "");
  }
}

function managerWith(
  driver: VmDriver,
  opts: { maxConcurrentVms?: number; maxQueued?: number; watchdogSweepMs?: number } = {},
): { manager: RuntimeManager; vm: VmManager } {
  const vm = new VmManager({ customDriver: driver });
  const manager = new RuntimeManager({
    vm,
    router: null,
    maxConcurrentVms: opts.maxConcurrentVms,
    maxQueued: opts.maxQueued,
    watchdogSweepMs: opts.watchdogSweepMs,
  });
  return { manager, vm };
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

async function waitForCalls(driver: PromptDelayVm, count: number, steps = 200): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (driver.calls.length >= count) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${count} claude calls`);
}

const allFinished = (runs: RunSummary[]) =>
  runs.length > 0 && runs.every((run) => run.status === "finished");

test.afterEach(() => {
  delete process.env.SWARM_MAX_CONCURRENT_VMS;
});

test("cap=2: third user's run queues for capacity and starts when a slot frees", async () => {
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, { maxConcurrentVms: 2 });

  const a = manager.start("alice", { prompt: "slow a" });
  const b = manager.start("bob", { prompt: "slow b" });
  assert.equal(a.queued, false);
  assert.equal(b.queued, false);

  const c = manager.start("carol", { prompt: "c work" });
  assert.equal(c.accepted, true, "capacity-queued runs are accepted, not errored");
  assert.equal(c.queued, true);
  assert.deepEqual(c.capacity, { limit: 2, inUse: 2, waiting: 1 });

  const events: Array<{ type: string; data?: unknown }> = [];
  telemetryBus.subscribe(c.runId, 0, (event) => events.push(event));
  const queuedEvent = events.find((event) => event.type === "run.queued");
  assert.ok(queuedEvent, "run.queued should be emitted for a capacity-queued prompt");
  const data = queuedEvent.data as { reason?: string; capacity?: unknown };
  assert.equal(data.reason, "capacity");
  assert.deepEqual(data.capacity, { limit: 2, inUse: 2, waiting: 1 });

  const carolQueued = manager.list("carol").find((run) => run.runId === c.runId);
  assert.equal(carolQueued?.status, "queued");
  assert.equal(carolQueued?.queueReason, "capacity");

  await waitForCalls(driver, 2);
  assert.deepEqual(
    [...driver.prompts()].sort(),
    ["slow a", "slow b"],
    "carol's claude must not spawn past the cap",
  );

  // Alice finishes, but her VM stays up (idle-but-alive) and still holds
  // the slot: carol keeps waiting.
  await waitFor(manager, "alice", allFinished);
  assert.equal(vm.isVmLive("alice"), true);
  assert.equal(
    manager.list("carol").find((run) => run.runId === c.runId)?.status,
    "queued",
    "an idle-but-alive VM still counts against the cap",
  );

  // Stopping alice's VM frees the slot; the drain starts carol.
  await vm.stop("alice");
  assert.equal(vm.isVmLive("alice"), false);
  manager.drainCapacityQueue();
  await waitForCalls(driver, 3);
  assert.equal(driver.prompts()[2], "c work");
  await waitFor(manager, "carol", allFinished);
});

test("watchdog sweep drains the capacity queue after a VM stops (backstop)", async () => {
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, { maxConcurrentVms: 1, watchdogSweepMs: 20 });

  manager.start("alice", { prompt: "a quick" });
  await waitFor(manager, "alice", allFinished);

  const b = manager.start("bob", { prompt: "b work" });
  assert.equal(b.queued, true);
  assert.equal(b.capacity?.limit, 1);
  assert.equal(b.capacity?.inUse, 1);

  // No manual drainCapacityQueue() call: the sweep must pick bob up once
  // alice's VM stops holding the only slot.
  await vm.stop("alice");
  await waitFor(manager, "bob", (runs) =>
    runs.some((run) => run.status === "running" || run.status === "finished"),
  );
  await waitFor(manager, "bob", allFinished);
});

test("a user whose VM is already live is never blocked by the cap", async () => {
  const driver = new PromptDelayVm();
  const { manager } = managerWith(driver, { maxConcurrentVms: 1 });

  manager.start("alice", { prompt: "a quick" });
  await waitFor(manager, "alice", allFinished);

  const b = manager.start("bob", { prompt: "b work" });
  assert.equal(b.queued, true, "alice's idle VM holds the only slot");

  const a2 = manager.start("alice", { prompt: "slow a again" });
  assert.equal(a2.queued, false, "alice reuses her live VM — no new slot needed");
  assert.equal(a2.capacity, undefined);
  assert.equal(
    manager.list("bob").find((run) => run.runId === b.runId)?.status,
    "queued",
    "bob still waits: alice's run did not consume or free a slot",
  );

  manager.cancel("alice", a2.runId);
});

test("capacity line is FIFO across users: oldest head starts first", async () => {
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, { maxConcurrentVms: 1 });

  const a = manager.start("alice", { prompt: "slow a" });
  await waitForCalls(driver, 1);

  const b = manager.start("bob", { prompt: "b work" });
  const c = manager.start("carol", { prompt: "c work" });
  assert.equal(b.capacity?.waiting, 1);
  assert.equal(c.capacity?.waiting, 2);

  // Free alice's slot entirely: cancel her run, stop her VM.
  manager.cancel("alice", a.runId);
  await vm.stop("alice");
  manager.drainCapacityQueue();
  await waitForCalls(driver, 2);
  assert.equal(driver.prompts()[1], "b work", "bob queued first, so bob starts first");
  assert.equal(manager.list("carol").find((run) => run.runId === c.runId)?.status, "queued");

  // Bob finishes; his VM still holds the slot until stopped.
  await waitFor(manager, "bob", allFinished);
  assert.equal(manager.list("carol").find((run) => run.runId === c.runId)?.status, "queued");
  await vm.stop("bob");
  manager.drainCapacityQueue();
  await waitForCalls(driver, 3);
  assert.equal(driver.prompts()[2], "c work");
});

test("SWARM_MAX_CONCURRENT_VMS env: 1 caps, 0 disables; constructor opt wins", async () => {
  process.env.SWARM_MAX_CONCURRENT_VMS = "1";
  const d1 = new PromptDelayVm();
  const { manager: m1 } = managerWith(d1);
  m1.start("alice", { prompt: "slow a" });
  const b = m1.start("bob", { prompt: "b work" });
  assert.equal(b.queued, true);
  assert.equal(b.capacity?.limit, 1);
  m1.cancel("alice");

  process.env.SWARM_MAX_CONCURRENT_VMS = "0";
  const d2 = new PromptDelayVm();
  const { manager: m2 } = managerWith(d2);
  const unlimited = ["alice", "bob", "carol"].map((userId) => m2.start(userId, { prompt: "slow x" }));
  assert.ok(
    unlimited.every((started) => started.accepted && !started.queued),
    "0 disables the cap",
  );
  for (const userId of ["alice", "bob", "carol"]) m2.cancel(userId);

  process.env.SWARM_MAX_CONCURRENT_VMS = "1";
  const d3 = new PromptDelayVm();
  const { manager: m3 } = managerWith(d3, { maxConcurrentVms: 3 });
  const overridden = ["alice", "bob"].map((userId) => m3.start(userId, { prompt: "slow x" }));
  assert.ok(
    overridden.every((started) => started.accepted && !started.queued),
    "constructor opt overrides the env var",
  );
  for (const userId of ["alice", "bob"]) m3.cancel(userId);
});

test("capacity-queued runs still count toward the per-user queue limit", async () => {
  const driver = new PromptDelayVm();
  const { manager } = managerWith(driver, { maxConcurrentVms: 1, maxQueued: 2 });

  manager.start("alice", { prompt: "slow a" });
  await waitForCalls(driver, 1);

  const b1 = manager.start("bob", { prompt: "b1" });
  const b2 = manager.start("bob", { prompt: "b2" });
  assert.equal(b1.queued, true);
  assert.equal(b2.queued, true);
  assert.equal(b2.position, 2);
  assert.equal(b2.capacity?.waiting, 2, "second in bob's own queue waits behind his head");

  const b3 = manager.start("bob", { prompt: "b3" });
  assert.equal(b3.accepted, false, "the per-user queue depth still bounds capacity waits");
  assert.equal(b3.limit, 2);

  manager.cancel("alice");
});

test("under the cap nothing changes: immediate starts, no capacity fields", async () => {
  const driver = new PromptDelayVm();
  const { manager } = managerWith(driver); // default cap 4

  const a = manager.start("alice", { prompt: "slow a" });
  const b = manager.start("bob", { prompt: "slow b" });
  assert.equal(a.queued, false);
  assert.equal(b.queued, false);
  assert.equal(a.capacity, undefined);
  assert.equal(b.capacity, undefined);

  // Same-user queueing is unchanged and carries no capacity marking.
  const a2 = manager.start("alice", { prompt: "a second" });
  assert.equal(a2.queued, true);
  assert.equal(a2.capacity, undefined);
  const queuedSummary = manager.list("alice").find((run) => run.runId === a2.runId);
  assert.equal(queuedSummary?.status, "queued");
  assert.equal(queuedSummary?.queueReason, undefined);

  manager.cancel("alice");
  manager.cancel("bob");
});

test("cancelling a capacity-queued run removes it from the line", async () => {
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, { maxConcurrentVms: 1 });

  const a = manager.start("alice", { prompt: "slow a" });
  await waitForCalls(driver, 1);

  const b = manager.start("bob", { prompt: "b work" });
  assert.equal(b.queued, true);
  assert.deepEqual(manager.cancel("bob", b.runId), { ok: true, runId: b.runId });
  assert.equal(manager.list("bob").find((run) => run.runId === b.runId)?.status, "cancelled");

  manager.cancel("alice", a.runId);
  await vm.stop("alice");
  manager.drainCapacityQueue();
  assert.equal(driver.calls.length, 1, "a cancelled capacity-queued run never starts");
});
