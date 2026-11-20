import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOUD_TARGET,
  cloudPoolStatus,
  computeTargetLabel,
  defaultComputeTarget,
  formatComputeTarget,
  isComputeTarget,
  isFreeTier,
  parseComputeTarget,
} from "./compute";
import type { Computer } from "./store";

function computer(id: string, name: string, online: boolean, lastSeenAt = 0): Computer {
  return {
    id,
    name,
    os: "linux",
    mode: "host",
    online,
    lastSeenAt,
    createdAt: 1,
    updatedAt: 1,
  };
}

function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

test("compute: parses cloud and computer targets", () => {
  assert.deepEqual(parseComputeTarget("cloud"), { kind: "cloud" });
  assert.deepEqual(parseComputeTarget(" Cloud "), { kind: "cloud" });
  assert.deepEqual(parseComputeTarget("computer:cmp_1234abcd"), {
    kind: "computer",
    computerId: "cmp_1234abcd",
  });
  assert.deepEqual(parseComputeTarget("computer:CMP_1234ABCD"), {
    kind: "computer",
    computerId: "cmp_1234abcd",
  });
  assert.equal(parseComputeTarget("computer:laptop"), null);
  assert.equal(parseComputeTarget("byoc"), null);
  assert.equal(parseComputeTarget(7), null);
  assert.equal(isComputeTarget(CLOUD_TARGET), true);
  assert.equal(isComputeTarget(formatComputeTarget("cmp_abcdef12")), true);
  assert.equal(isComputeTarget("computer:nope"), false);
});

test("compute: pool capacity defaults and env override", () => {
  assert.deepEqual(cloudPoolStatus(0, env()), { capacity: 5, inUse: 0, full: false });
  assert.deepEqual(cloudPoolStatus(5, env()), { capacity: 5, inUse: 5, full: true });
  assert.deepEqual(cloudPoolStatus(2, env({ SWARM_CLOUD_POOL_CAPACITY: "2" })), {
    capacity: 2,
    inUse: 2,
    full: true,
  });
  assert.deepEqual(cloudPoolStatus(0, env({ SWARM_CLOUD_POOL_CAPACITY: "0" })), {
    capacity: 0,
    inUse: 0,
    full: true,
  });
  assert.deepEqual(cloudPoolStatus(1, env({ SWARM_CLOUD_POOL_CAPACITY: "oops" })), {
    capacity: 5,
    inUse: 1,
    full: false,
  });
});

test("compute: paid accounts are read from SWARM_PAID_USERS", () => {
  assert.equal(isFreeTier("alice", env()), true);
  assert.equal(isFreeTier("alice", env({ SWARM_PAID_USERS: "bob, alice" })), false);
  assert.equal(isFreeTier("alice", env({ SWARM_PAID_USERS: "bob" })), true);
});

test("compute: paid-user matching is case-insensitive", () => {
  // local_<email> ids can vary in casing; the paid list must still match.
  assert.equal(isFreeTier("local_Alice@Example.com", env({ SWARM_PAID_USERS: "local_alice@example.com" })), false);
  assert.equal(isFreeTier("local_alice@example.com", env({ SWARM_PAID_USERS: "local_Alice@Example.com" })), false);
  assert.equal(isFreeTier("local_bob@example.com", env({ SWARM_PAID_USERS: "local_alice@example.com" })), true);
});

test("compute: free tier defaults to BYOC only when the pool is full", () => {
  const computers = [
    computer("cmp_aaaaaaaa", "Old", true, 100),
    computer("cmp_bbbbbbbb", "Newest", true, 300),
    computer("cmp_cccccccc", "Offline", false, 400),
  ];
  assert.equal(
    defaultComputeTarget({ freeTier: true, poolFull: true, computers }),
    formatComputeTarget("cmp_bbbbbbbb"),
  );
  assert.equal(defaultComputeTarget({ freeTier: true, poolFull: false, computers }), "cloud");
  assert.equal(defaultComputeTarget({ freeTier: false, poolFull: true, computers }), "cloud");
  assert.equal(defaultComputeTarget({ freeTier: true, poolFull: true, computers: [] }), "cloud");
  assert.equal(
    defaultComputeTarget({ freeTier: true, poolFull: true, computers: [computers[2]] }),
    "cloud",
  );
});

test("compute: labels resolve a computer name or the cloud", () => {
  const computers = [computer("cmp_aaaaaaaa", "Studio Mac", true)];
  assert.equal(computeTargetLabel("cloud", computers), "SwarmAgents cloud");
  assert.equal(computeTargetLabel("computer:cmp_aaaaaaaa", computers), "Studio Mac");
  assert.equal(computeTargetLabel("computer:cmp_deadbeef", computers), "Your computer");
  assert.equal(computeTargetLabel(undefined, computers), "SwarmAgents cloud");
});
