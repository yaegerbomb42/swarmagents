/**
 * On-demand VM eviction for the global concurrent-VM cap (FIX-19 follow-up).
 *
 * When a run queues for VM capacity, the longest-idle live VM with no
 * active run, no queued work, and no exec in flight is hibernated
 * immediately (the idle sweeper's stop path and safety predicate, with a
 * 60s idle floor instead of the 30 min sweeper window) so the queued run
 * starts now instead of waiting out SWARM_VM_IDLE_MIN. Eviction is
 * best-effort: no qualifying VM, a failed stop, or disabled hibernation
 * leaves the run queued exactly as FIX-19 left it.
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

const SECOND = 1_000;
const MINUTE = 60_000;

class FakeClock {
  private t = 0;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_evict", model: "claude-test" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_evict", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

/** Fake driver whose claude execs sleep when the prompt says so. */
class PromptDelayVm extends FakeVmDriver {
  calls: string[][] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.calls.push(cmd);
    const prompt = cmd.at(-1) ?? "";
    if (prompt.includes("veryslow")) await sleep(5_000);
    else if (prompt.includes("slow")) await sleep(600);
    if (opts?.signal?.aborted) return { exitCode: 130 };
    for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
    return { exitCode: 0 };
  }

  prompts(): string[] {
    return this.calls.map((cmd) => cmd.at(-1) ?? "");
  }
}

/** Fake driver whose stop() always fails (eviction failure path). */
class FailingStopVm extends PromptDelayVm {
  override async stop(_handle: VmHandle): Promise<void> {
    throw new Error("docker stop failed (injected)");
  }
}

function managerWith(
  driver: VmDriver,
  clock: FakeClock,
  opts: { maxConcurrentVms?: number; evictionMinIdleMs?: number; idleMinutes?: number } = {},
): { manager: RuntimeManager; vm: VmManager } {
  const vm = new VmManager({
    customDriver: driver,
    now: clock.now,
    idle: { idleMinutes: opts.idleMinutes ?? 30 },
  });
  const manager = new RuntimeManager({
    vm,
    router: null,
    maxConcurrentVms: opts.maxConcurrentVms,
    evictionMinIdleMs: opts.evictionMinIdleMs,
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

function collectEvents(runId: string): Array<{ type: string; data?: unknown }> {
  const events: Array<{ type: string; data?: unknown }> = [];
  telemetryBus.subscribe(runId, 0, (event) => events.push(event));
  return events;
}

test.afterEach(() => {
  delete process.env.SWARM_MAX_CONCURRENT_VMS;
  delete process.env.SWARM_VM_EVICTION_MIN_IDLE_SEC;
});

test("a capacity-queued run evicts the longest-idle VM and starts", async () => {
  const clock = new FakeClock();
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, clock, { maxConcurrentVms: 2 });

  manager.start("alice", { prompt: "a quick" });
  await waitFor(manager, "alice", allFinished);

  clock.advance(3 * MINUTE);
  manager.start("bob", { prompt: "b quick" });
  await waitFor(manager, "bob", allFinished);

  // Alice idle 5m, bob idle 2m; both VMs live and holding the cap.
  clock.advance(2 * MINUTE);
  const c = manager.start("carol", { prompt: "c work" });
  assert.equal(c.accepted, true);
  assert.equal(c.queued, true, "carol queues first; eviction is async");
  assert.deepEqual(c.capacity, { limit: 2, inUse: 2, waiting: 1 });

  await waitFor(manager, "carol", allFinished);
  assert.equal(vm.isVmLive("alice"), false, "longest-idle VM was hibernated");
  assert.equal(vm.isVmLive("bob"), true, "the less-idle VM was left alone");

  const evicted = collectEvents(c.runId).find((event) => event.type === "vm.evicted");
  assert.ok(evicted, "the queued run's stream records the eviction that freed its slot");
  const data = evicted.data as { evictedUserId?: string; idleMs?: number; reason?: string };
  assert.equal(data.evictedUserId, "alice");
  assert.equal(data.idleMs, 5 * MINUTE);
  assert.equal(data.reason, "capacity");
});

test("a VM with an active run is never evicted", async () => {
  const clock = new FakeClock();
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, clock, { maxConcurrentVms: 1 });

  const a = manager.start("alice", { prompt: "veryslow a" });
  await waitForCalls(driver, 1);

  // Alice's last activity is old, but her run (and its exec) is in flight.
  clock.advance(10 * MINUTE);
  const b = manager.start("bob", { prompt: "b work" });
  assert.equal(b.queued, true);

  await sleep(150);
  assert.equal(
    manager.list("bob").find((run) => run.runId === b.runId)?.status,
    "queued",
    "bob keeps waiting: the only VM has an active run",
  );
  assert.equal(vm.isVmLive("alice"), true);
  assert.equal(
    collectEvents(b.runId).some((event) => event.type === "vm.evicted"),
    false,
  );

  manager.cancel("alice", a.runId);
  manager.cancel("bob", b.runId);
});

test("a VM idle for less than the floor is not evicted; the drain retries later", async () => {
  const clock = new FakeClock();
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, clock, { maxConcurrentVms: 1 });

  manager.start("alice", { prompt: "a quick" });
  await waitFor(manager, "alice", allFinished);

  clock.advance(10 * SECOND); // idle 10s < 60s floor
  const b = manager.start("bob", { prompt: "b work" });
  assert.equal(b.queued, true);
  await sleep(150);
  assert.equal(
    manager.list("bob").find((run) => run.runId === b.runId)?.status,
    "queued",
    "recently-active VM is not yanked",
  );
  assert.equal(vm.isVmLive("alice"), true);

  // Once the floor passes, the next capacity drain (the watchdog sweep
  // calls it every 30s) evicts and starts bob.
  clock.advance(2 * MINUTE);
  manager.drainCapacityQueue();
  await waitFor(manager, "bob", allFinished);
  assert.equal(vm.isVmLive("alice"), false);
});

test("a failed eviction leaves the run queued and the VM live", async () => {
  const clock = new FakeClock();
  const driver = new FailingStopVm();
  const { manager, vm } = managerWith(driver, clock, { maxConcurrentVms: 1 });

  manager.start("alice", { prompt: "a quick" });
  await waitFor(manager, "alice", allFinished);

  clock.advance(5 * MINUTE);
  const b = manager.start("bob", { prompt: "b work" });
  assert.equal(b.queued, true);

  await sleep(150);
  assert.equal(
    manager.list("bob").find((run) => run.runId === b.runId)?.status,
    "queued",
    "eviction is best-effort: a failed stop changes nothing",
  );
  assert.equal(vm.isVmLive("alice"), true);
  assert.equal(
    collectEvents(b.runId).some((event) => event.type === "vm.evicted"),
    false,
  );

  manager.cancel("bob", b.runId);
});

test("under the cap nothing is evicted and nothing changes", async () => {
  const clock = new FakeClock();
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, clock); // default cap 4

  const a = manager.start("alice", { prompt: "slow a" });
  const b = manager.start("bob", { prompt: "slow b" });
  assert.equal(a.queued, false);
  assert.equal(b.queued, false);
  assert.equal(a.capacity, undefined);
  assert.equal(b.capacity, undefined);

  await waitForCalls(driver, 2);
  assert.equal(
    [...collectEvents(a.runId), ...collectEvents(b.runId)].some(
      (event) => event.type === "vm.evicted",
    ),
    false,
  );
  assert.equal(vm.isVmLive("alice"), true);
  assert.equal(vm.isVmLive("bob"), true);

  manager.cancel("alice", a.runId);
  manager.cancel("bob", b.runId);
});

test("no eviction when hibernation is disabled (SWARM_VM_IDLE_MIN=0)", async () => {
  const clock = new FakeClock();
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, clock, { maxConcurrentVms: 1, idleMinutes: 0 });

  manager.start("alice", { prompt: "a quick" });
  await waitFor(manager, "alice", allFinished);

  clock.advance(60 * MINUTE);
  const b = manager.start("bob", { prompt: "b work" });
  assert.equal(b.queued, true);

  await sleep(150);
  assert.equal(
    manager.list("bob").find((run) => run.runId === b.runId)?.status,
    "queued",
    "hibernation off means eviction off: bob waits as before",
  );
  assert.equal(vm.isVmLive("alice"), true);

  manager.cancel("bob", b.runId);
});

test("two waiters and one idle VM: only the head of the line starts", async () => {
  const clock = new FakeClock();
  const driver = new PromptDelayVm();
  const { manager, vm } = managerWith(driver, clock, { maxConcurrentVms: 2 });

  manager.start("alice", { prompt: "a quick" });
  await waitFor(manager, "alice", allFinished);
  const b = manager.start("bob", { prompt: "veryslow b" });
  await waitForCalls(driver, 2);

  clock.advance(5 * MINUTE); // alice idle 5m; bob's run still active
  const c = manager.start("carol", { prompt: "c work" });
  const d = manager.start("dan", { prompt: "d work" });
  assert.equal(c.capacity?.waiting, 1);
  assert.equal(d.capacity?.waiting, 2);

  await waitFor(manager, "carol", allFinished);
  assert.equal(vm.isVmLive("alice"), false, "the one idle VM was evicted for the head");
  assert.equal(vm.isVmLive("bob"), true, "bob's active run keeps his VM");
  assert.equal(
    manager.list("dan").find((run) => run.runId === d.runId)?.status,
    "queued",
    "dan still waits: no second idle VM to evict",
  );

  manager.cancel("bob", b.runId);
  manager.cancel("dan", d.runId);
});

test("eviction floor: SWARM_VM_EVICTION_MIN_IDLE_SEC, constructor opt wins", async () => {
  process.env.SWARM_VM_EVICTION_MIN_IDLE_SEC = "5";
  const clock1 = new FakeClock();
  const d1 = new PromptDelayVm();
  const { manager: m1, vm: vm1 } = managerWith(d1, clock1, { maxConcurrentVms: 1 });

  m1.start("alice", { prompt: "a quick" });
  await waitFor(m1, "alice", allFinished);
  clock1.advance(3 * SECOND); // idle 3s < 5s env floor
  const b1 = m1.start("bob", { prompt: "b work" });
  assert.equal(b1.queued, true);
  await sleep(150);
  assert.equal(vm1.isVmLive("alice"), true, "env floor holds");

  clock1.advance(3 * SECOND); // idle 6s >= 5s floor
  m1.drainCapacityQueue();
  await waitFor(m1, "bob", allFinished);
  assert.equal(vm1.isVmLive("alice"), false);

  const clock2 = new FakeClock();
  const d2 = new PromptDelayVm();
  const { manager: m2, vm: vm2 } = managerWith(d2, clock2, {
    maxConcurrentVms: 1,
    evictionMinIdleMs: 1_000, // opt overrides the 5s env floor
  });
  m2.start("alice", { prompt: "a quick" });
  await waitFor(m2, "alice", allFinished);
  clock2.advance(2 * SECOND); // idle 2s: past the 1s opt floor, under the 5s env floor
  const b2 = m2.start("bob", { prompt: "b work" });
  assert.equal(b2.queued, true);
  await waitFor(m2, "bob", allFinished);
  assert.equal(vm2.isVmLive("alice"), false, "constructor opt overrides the env var");
});
