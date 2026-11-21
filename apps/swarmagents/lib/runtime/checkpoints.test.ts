import test from "node:test";
import assert from "node:assert/strict";
import {
  checkpointDisplayLabel,
  checkpointVmLabel,
  createCheckpointTaker,
  parseCheckpointVmLabel,
  resolveCheckpointStepSeq,
  takeRunCheckpoint,
} from "./checkpoints";

const RUN_ID = "run_11111111-2222-3333-4444-555555555555";

test("display label is auto-pre-step-<seq>", () => {
  assert.equal(checkpointDisplayLabel(1), "auto-pre-step-1");
  assert.equal(checkpointDisplayLabel(12), "auto-pre-step-12");
});

test("VM label namespaces the display label by runId", () => {
  assert.equal(
    checkpointVmLabel(RUN_ID, 12),
    "run_11111111-2222-3333-4444-555555555555-auto-pre-step-12",
  );
  // Two runs never share a VM label for the same step: separate lineages.
  assert.notEqual(checkpointVmLabel(RUN_ID, 12), checkpointVmLabel("run_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", 12));
});

test("VM label fits the driver snapshot charset (<=64 chars, no '..')", () => {
  const label = checkpointVmLabel(RUN_ID, 999999);
  assert.ok(label.length <= 64, `label too long: ${label.length}`);
  assert.match(label, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.ok(!label.includes(".."));
});

test("parseCheckpointVmLabel round-trips a VM label", () => {
  assert.deepEqual(parseCheckpointVmLabel(checkpointVmLabel(RUN_ID, 7)), {
    runId: RUN_ID,
    laneId: undefined,
    stepSeq: 7,
  });
  // Lane-scoped labels round-trip with the lane id preserved.
  assert.deepEqual(parseCheckpointVmLabel(checkpointVmLabel(RUN_ID, 3, "a1")), {
    runId: RUN_ID,
    laneId: "a1",
    stepSeq: 3,
  });
  assert.deepEqual(parseCheckpointVmLabel(checkpointVmLabel(RUN_ID, 1, "reviewer")), {
    runId: RUN_ID,
    laneId: "reviewer",
    stepSeq: 1,
  });
});

test("parseCheckpointVmLabel rejects non-checkpoint labels", () => {
  assert.equal(parseCheckpointVmLabel("manual-backup"), null);
  assert.equal(parseCheckpointVmLabel("auto-pre-step-7"), null);
  assert.equal(parseCheckpointVmLabel(`${RUN_ID}-auto-pre-step-0x`), null);
});

test("resolveCheckpointStepSeq accepts a step number or a display label", () => {
  assert.equal(resolveCheckpointStepSeq(12), 12);
  assert.equal(resolveCheckpointStepSeq("auto-pre-step-12"), 12);
  assert.equal(resolveCheckpointStepSeq("  auto-pre-step-3  "), 3);
});

test("resolveCheckpointStepSeq rejects 0, negatives, fractions, and junk", () => {
  assert.equal(resolveCheckpointStepSeq(0), null);
  assert.equal(resolveCheckpointStepSeq(-4), null);
  assert.equal(resolveCheckpointStepSeq(1.5), null);
  assert.equal(resolveCheckpointStepSeq("auto-pre-step-0"), null);
  assert.equal(resolveCheckpointStepSeq("auto-pre-step-x"), null);
  assert.equal(resolveCheckpointStepSeq("pre-step-12"), null);
  assert.equal(resolveCheckpointStepSeq(""), null);
});

test("takeRunCheckpoint returns the outcome, never throws", async () => {
  const seen: string[] = [];
  const ok = await takeRunCheckpoint(
    async (vmLabel) => {
      seen.push(vmLabel);
      return { createdAt: 1234 };
    },
    RUN_ID,
    7,
  );
  assert.deepEqual(ok, {
    ok: true,
    label: "auto-pre-step-7",
    vmLabel: `${RUN_ID}-auto-pre-step-7`,
    stepSeq: 7,
    createdAt: 1234,
  });
  assert.deepEqual(seen, [`${RUN_ID}-auto-pre-step-7`]);

  const failed = await takeRunCheckpoint(async () => {
    throw new Error("docker is down");
  }, RUN_ID, 8);
  assert.deepEqual(failed, {
    ok: false,
    label: "auto-pre-step-8",
    vmLabel: `${RUN_ID}-auto-pre-step-8`,
    stepSeq: 8,
    error: "docker is down",
  });
});

test("createCheckpointTaker counts its own steps per lane", async () => {
  const seen: string[] = [];
  const fakeVm = {
    snapshotDuringRun: async (_userId: string, vmLabel: string) => {
      seen.push(vmLabel);
      return { label: vmLabel, createdAt: 99 };
    },
  };
  const takeCheckpoint = createCheckpointTaker(fakeVm, "alice", RUN_ID, "a1");

  const first = await takeCheckpoint({ toolName: "Bash", reason: "ask" });
  const second = await takeCheckpoint({ toolName: "Write", reason: "ask" });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.label, "auto-pre-step-1");
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.label, "auto-pre-step-2");
  // Lane-scoped VM labels: lane `a1` prefixes its own id, so two lanes of the
  // same run checkpointing step 1 no longer collide.
  assert.deepEqual(seen, [`${RUN_ID}-a1-step-1`, `${RUN_ID}-a1-step-2`]);

  // A second lane of the same run gets its own label namespace.
  const other = createCheckpointTaker(fakeVm, "alice", RUN_ID, "a2");
  const otherFirst = await other({ toolName: "Bash", reason: "ask" });
  assert.equal(otherFirst.ok, true);
  if (otherFirst.ok) assert.equal(otherFirst.label, "auto-pre-step-1");
  assert.deepEqual(seen, [
    `${RUN_ID}-a1-step-1`,
    `${RUN_ID}-a1-step-2`,
    `${RUN_ID}-a2-step-1`,
  ]);
});

test("createCheckpointTaker surfaces a snapshot failure as {ok:false}", async () => {
  const fakeVm = {
    snapshotDuringRun: async () => {
      throw new Error("snapshot boom");
    },
  };
  const takeCheckpoint = createCheckpointTaker(fakeVm, "alice", RUN_ID, "a1");
  const outcome = await takeCheckpoint({ toolName: "Bash", reason: "ask" });
  assert.deepEqual(outcome, {
    ok: false,
    label: "auto-pre-step-1",
    vmLabel: `${RUN_ID}-a1-step-1`,
    stepSeq: 1,
    error: "snapshot boom",
  });
});

test("lane-scoped VM label stays within the 64-char driver limit", () => {
  // The longest real lane id is "reviewer" (8 chars); even with a large step
  // the label must stay <= 64 chars and match the snapshot charset.
  const label = checkpointVmLabel(RUN_ID, 9999, "reviewer");
  assert.ok(label.length <= 64, `label too long: ${label.length} (${label})`);
  assert.match(label, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.ok(!label.includes(".."));
  assert.equal(label, `${RUN_ID}-reviewer-step-9999`);
});

test("two concurrent lanes of one run checkpointing the same step do not collide", () => {
  const laneA = checkpointVmLabel(RUN_ID, 1, "a1");
  const laneB = checkpointVmLabel(RUN_ID, 1, "a2");
  assert.notEqual(laneA, laneB);
  assert.equal(laneA, `${RUN_ID}-a1-step-1`);
  assert.equal(laneB, `${RUN_ID}-a2-step-1`);
  // The normal-run (fork) path keeps its old label so existing forks still resolve.
  assert.equal(checkpointVmLabel(RUN_ID, 1), `${RUN_ID}-auto-pre-step-1`);
});

test("ResumePoint round-trips with runId, checkpointLabel, stepSeq and sessionId", () => {
  const pt = {
    runId: RUN_ID,
    checkpointLabel: checkpointDisplayLabel(5),
    stepSeq: 5,
    sessionId: "sess_123",
  };
  assert.equal(pt.runId, RUN_ID);
  assert.equal(pt.checkpointLabel, "auto-pre-step-5");
  assert.equal(pt.stepSeq, 5);
  assert.equal(pt.sessionId, "sess_123");
});
