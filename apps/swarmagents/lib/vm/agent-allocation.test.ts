// Per-agent VM allocation: owner keys, isolation, reuse, persistence
// toggle, concurrent-VM cap, and the idle reaper — all against the fake
// driver (no docker needed).

import test from "node:test";
import assert from "node:assert/strict";
import { FakeVmDriver } from "./fake-driver.js";
import { VmManager } from "./manager.js";
import { containerNameFor } from "./docker-driver.js";
import {
  AgentVmAllocator,
  AgentVmCapError,
  DEFAULT_AGENT_ID,
  agentOwnerKey,
  containerNameForAgent,
  isValidAgentId,
  resolveAgentVmConfig,
  validateAgentId,
  type AgentVmAllocatorOptions,
} from "./agent-allocation.js";
import { VmFileError } from "./files.js";

const MINUTE = 60_000;

class FakeClock {
  private t = 0;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

function setup(opts?: AgentVmAllocatorOptions, clock?: FakeClock) {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, now: clock?.now });
  const allocator = new AgentVmAllocator(manager, { ...opts, now: clock?.now });
  return { driver, manager, allocator };
}

async function writeVia(manager: VmManager, ownerKey: string, path: string, content: string) {
  await manager.writeFile(ownerKey, path, content);
}

async function readVia(manager: VmManager, ownerKey: string, path: string) {
  return manager.readFile(ownerKey, path);
}

// ---------------------------------------------------------------------------
// Owner keys
// ---------------------------------------------------------------------------

test("agentOwnerKey: the default agent (A1) keeps the plain userId key", () => {
  assert.equal(agentOwnerKey("user-1"), "user-1");
  assert.equal(agentOwnerKey("user-1", DEFAULT_AGENT_ID), "user-1");
  assert.equal(agentOwnerKey("user-1", "a1"), "user-1");
});

test("agentOwnerKey: a named agent gets a distinct, deterministic key", () => {
  const key = agentOwnerKey("user-1", "worker-2");
  assert.equal(key, "agent:worker-2:user-1");
  assert.equal(agentOwnerKey("user-1", "worker-2"), key);
  assert.notEqual(agentOwnerKey("user-1", "worker-2"), agentOwnerKey("user-1", "worker-3"));
  assert.notEqual(agentOwnerKey("user-1", "worker-2"), agentOwnerKey("user-2", "worker-2"));
  assert.notEqual(agentOwnerKey("user-1", "worker-2"), agentOwnerKey("user-1"));
});

test("validateAgentId rejects ids that could escape their slot", () => {
  assert.equal(validateAgentId("worker-2"), "worker-2");
  assert.equal(validateAgentId("a1"), "a1");
  for (const bad of ["", "a/b", "a b", "../x", "a:b", "a".repeat(65), ".hidden", "-dash"]) {
    assert.throws(() => validateAgentId(bad), /agentId/, bad);
  }
  assert.equal(isValidAgentId("ok_1.2-3"), true);
  assert.equal(isValidAgentId("no/slash"), false);
  assert.equal(isValidAgentId(undefined), false);
  assert.throws(() => agentOwnerKey("user-1", "bad/id"), /agentId/);
});

test("containerNameForAgent is injective per agent (docker naming)", () => {
  const a = containerNameForAgent("user-1", "worker-2");
  const b = containerNameForAgent("user-1", "worker-3");
  const c = containerNameForAgent("user-1");
  assert.equal(a, containerNameFor(agentOwnerKey("user-1", "worker-2")));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

test("resolveAgentVmConfig: defaults, env, and explicit options", () => {
  assert.deepEqual(resolveAgentVmConfig(undefined, {}), { maxAgentVms: 4, idleReapMinutes: 30 });
  assert.deepEqual(
    resolveAgentVmConfig(undefined, { SWARM_VM_MAX_AGENT_VMS: "2", SWARM_VM_AGENT_IDLE_MIN: "5" }),
    { maxAgentVms: 2, idleReapMinutes: 5 },
  );
  // Falls back to the global VM settings when the agent-specific ones are absent.
  assert.deepEqual(
    resolveAgentVmConfig(undefined, { SWARM_MAX_CONCURRENT_VMS: "7", SWARM_VM_IDLE_MIN: "45" }),
    { maxAgentVms: 7, idleReapMinutes: 45 },
  );
  // Invalid env falls back instead of breaking allocation.
  assert.deepEqual(
    resolveAgentVmConfig(undefined, { SWARM_VM_MAX_AGENT_VMS: "nope", SWARM_VM_AGENT_IDLE_MIN: "-1" }),
    { maxAgentVms: 4, idleReapMinutes: 30 },
  );
  assert.deepEqual(resolveAgentVmConfig({ maxAgentVms: 1, idleReapMinutes: 0 }, {}), {
    maxAgentVms: 1,
    idleReapMinutes: 0,
  });
});

// ---------------------------------------------------------------------------
// Allocation: distinct desktops, reuse, isolation
// ---------------------------------------------------------------------------

test("two concurrent agents get two distinct desktops", async () => {
  const { allocator } = setup();
  const a = await allocator.allocate("user-1", "worker-2");
  const b = await allocator.allocate("user-1", "worker-3");
  assert.notEqual(a.containerName, b.containerName);
  assert.equal(a.reused, false);
  assert.equal(b.reused, false);
  assert.equal(a.ownerKey, "agent:worker-2:user-1");
  assert.equal(b.ownerKey, "agent:worker-3:user-1");
  assert.equal(allocator.liveAgentVmCount(), 2);
});

test("two agents cannot see each other's files", async () => {
  const { manager, allocator } = setup();
  const keyA = agentOwnerKey("user-1", "worker-2");
  const keyB = agentOwnerKey("user-1", "worker-3");
  await allocator.allocate("user-1", "worker-2");
  await allocator.allocate("user-1", "worker-3");
  await writeVia(manager, keyA, "/workspace/secret.txt", "agent-two-only");
  assert.equal(await readVia(manager, keyA, "/workspace/secret.txt"), "agent-two-only");
  await assert.rejects(readVia(manager, keyB, "/workspace/secret.txt"), (error: unknown) => {
    assert.ok(error instanceof VmFileError);
    assert.equal(error.code, "not_found");
    return true;
  });
});

test("a second task for the same agent reuses its VM", async () => {
  const { allocator } = setup();
  const first = await allocator.startTask("user-1", "worker-2", { mode: "persistent" });
  const second = await allocator.startTask("user-1", "worker-2", { mode: "persistent" });
  assert.equal(first.containerName, second.containerName);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.reset, false);
  assert.equal(allocator.listAllocations().length, 1);
});

test("the default agent reuses the existing per-user VM", async () => {
  const { manager, allocator } = setup();
  const direct = await manager.ensure("user-1");
  const viaAllocator = await allocator.allocate("user-1");
  assert.equal(viaAllocator.containerName, direct.containerName);
  assert.equal(viaAllocator.ownerKey, "user-1");
  assert.equal(viaAllocator.reused, true);
});

// ---------------------------------------------------------------------------
// Persistence toggle
// ---------------------------------------------------------------------------

test("persistent mode keeps files across the agent's tasks", async () => {
  const { manager, allocator } = setup();
  const key = agentOwnerKey("user-1", "worker-2");
  await allocator.startTask("user-1", "worker-2", { mode: "persistent" });
  await writeVia(manager, key, "/workspace/notes.txt", "keep me");
  const second = await allocator.startTask("user-1", "worker-2", { mode: "persistent" });
  assert.equal(second.reset, false);
  assert.equal(await readVia(manager, key, "/workspace/notes.txt"), "keep me");
});

test("fresh-per-task resets the VM so the next task starts clean", async () => {
  const { manager, allocator } = setup();
  const key = agentOwnerKey("user-1", "worker-2");
  await allocator.startTask("user-1", "worker-2", { mode: "fresh-per-task" });
  await writeVia(manager, key, "/workspace/notes.txt", "task one");
  const second = await allocator.startTask("user-1", "worker-2", { mode: "fresh-per-task" });
  assert.equal(second.reset, true);
  await assert.rejects(readVia(manager, key, "/workspace/notes.txt"), (error: unknown) => {
    assert.ok(error instanceof VmFileError);
    return true;
  });
});

test("fresh-per-task does not reset a VM that was never created", async () => {
  const { allocator } = setup();
  const first = await allocator.startTask("user-1", "worker-2", { mode: "fresh-per-task" });
  assert.equal(first.reset, false);
  assert.equal(first.reused, false);
});

test("terminate-at-project-end stops the VM only when no work remains", async () => {
  const { allocator } = setup();
  await allocator.startTask("user-1", "worker-2", { mode: "terminate-at-project-end" });
  const kept = await allocator.endTask("user-1", "worker-2", {
    mode: "terminate-at-project-end",
    hasRemainingWork: true,
  });
  assert.equal(kept.stopped, false);
  assert.equal(allocator.isAgentVmLive("user-1", "worker-2"), true);
  const stopped = await allocator.endTask("user-1", "worker-2", {
    mode: "terminate-at-project-end",
    hasRemainingWork: false,
  });
  assert.equal(stopped.stopped, true);
  assert.equal(allocator.isAgentVmLive("user-1", "worker-2"), false);
  // Persistent mode never stops at task end.
  await allocator.startTask("user-1", "worker-2", { mode: "persistent" });
  const persistent = await allocator.endTask("user-1", "worker-2", {
    mode: "persistent",
    hasRemainingWork: false,
  });
  assert.equal(persistent.stopped, false);
  assert.equal(allocator.isAgentVmLive("user-1", "worker-2"), true);
});

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

test("the concurrent cap refuses a third agent VM and frees on stop", async () => {
  const { allocator } = setup({ maxAgentVms: 2 });
  await allocator.allocate("user-1", "worker-2");
  await allocator.allocate("user-1", "worker-3");
  await assert.rejects(allocator.allocate("user-1", "worker-4"), (error: unknown) => {
    assert.ok(error instanceof AgentVmCapError);
    assert.equal(error.cap, 2);
    return true;
  });
  // The default agent's VM is governed by the global cap, not this one.
  await allocator.allocate("user-1");
  await allocator.stopAgent("user-1", "worker-2");
  const fourth = await allocator.allocate("user-1", "worker-4");
  assert.equal(fourth.reused, false);
});

// ---------------------------------------------------------------------------
// Idle reaper
// ---------------------------------------------------------------------------

test("the idle reaper stops only VMs past the timeout", async () => {
  const clock = new FakeClock();
  const { manager, allocator } = setup({ idleReapMinutes: 30 }, clock);
  await allocator.allocate("user-1", "worker-2");
  await allocator.allocate("user-1", "worker-3");
  clock.advance(10 * MINUTE);
  // worker-3 does something at t=10m, so only worker-2 is idle at t=39m.
  manager.touch(agentOwnerKey("user-1", "worker-3"));
  clock.advance(29 * MINUTE);
  const reaped = await allocator.reapIdle();
  assert.deepEqual(reaped, ["agent:worker-2:user-1"]);
  assert.equal(allocator.isAgentVmLive("user-1", "worker-2"), false);
  assert.equal(allocator.isAgentVmLive("user-1", "worker-3"), true);
  assert.equal(allocator.allocationFor("user-1", "worker-2"), undefined);
  assert.ok(allocator.allocationFor("user-1", "worker-3"));
});

test("the idle reaper never stops an always-on agent VM", async () => {
  const clock = new FakeClock();
  const { manager, allocator } = setup({ idleReapMinutes: 30 }, clock);
  await allocator.allocate("user-1", "worker-2");
  manager.setAlwaysOn(agentOwnerKey("user-1", "worker-2"), true);
  clock.advance(24 * 60 * MINUTE);
  assert.deepEqual(await allocator.reapIdle(), []);
  assert.equal(allocator.isAgentVmLive("user-1", "worker-2"), true);
});

test("the idle reaper is disabled when the window is 0", async () => {
  const clock = new FakeClock();
  const { allocator } = setup({ idleReapMinutes: 0 }, clock);
  await allocator.allocate("user-1", "worker-2");
  clock.advance(24 * 60 * MINUTE);
  assert.deepEqual(await allocator.reapIdle(), []);
  assert.equal(allocator.isAgentVmLive("user-1", "worker-2"), true);
});

// ---------------------------------------------------------------------------
// Teardown + desktop endpoint
// ---------------------------------------------------------------------------

test("destroyAgent wipes the volume and forgets the allocation", async () => {
  const { manager, allocator } = setup();
  const key = agentOwnerKey("user-1", "worker-2");
  await allocator.allocate("user-1", "worker-2");
  await writeVia(manager, key, "/workspace/notes.txt", "gone");
  assert.equal(await allocator.destroyAgent("user-1", "worker-2"), true);
  assert.equal(allocator.allocationFor("user-1", "worker-2"), undefined);
  assert.equal(await allocator.destroyAgent("user-1", "worker-2"), false);
  await allocator.allocate("user-1", "worker-2");
  await assert.rejects(readVia(manager, key, "/workspace/notes.txt"), (error: unknown) => {
    assert.ok(error instanceof VmFileError);
    return true;
  });
});

test("desktopEndpoint returns null on a driver with no desktop", async () => {
  const { allocator } = setup();
  await allocator.allocate("user-1", "worker-2");
  assert.equal(await allocator.desktopEndpoint("user-1", "worker-2"), null);
});

test("exec runs inside the agent's own VM", async () => {
  const { manager, allocator } = setup();
  const keyA = agentOwnerKey("user-1", "worker-2");
  await allocator.allocate("user-1", "worker-2");
  await allocator.allocate("user-1", "worker-3");
  await writeVia(manager, keyA, "/workspace/agent.txt", "worker-2 was here");
  // cat through the agent's own exec sees the file; the other agent's exec does not.
  let seen = "";
  const own = await allocator.exec("user-1", "worker-2", ["cat", "/workspace/agent.txt"], {
    onStdout: (chunk) => {
      seen += chunk;
    },
  });
  assert.equal(own.exitCode, 0);
  assert.equal(seen, "worker-2 was here");
  const other = await allocator.exec("user-1", "worker-3", ["cat", "/workspace/agent.txt"]);
  assert.equal(other.exitCode, 1);
});
