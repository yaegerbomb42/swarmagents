import test from "node:test";
import assert from "node:assert/strict";
import { shouldResetVmAtRunStart, shouldStopVmAtRunEnd } from "./vm-persistence";

test("fresh-per-task resets before a new task", () => {
  assert.equal(shouldResetVmAtRunStart("fresh-per-task", {}), true);
});

test("fresh-per-task never wipes a fork seed (checkpoint restore follows ensure)", () => {
  assert.equal(
    shouldResetVmAtRunStart("fresh-per-task", { seedSnapshotLabel: "ckpt-1" }),
    false,
  );
});

test("persistent and terminate-at-project-end never reset at start", () => {
  assert.equal(shouldResetVmAtRunStart("persistent", {}), false);
  assert.equal(shouldResetVmAtRunStart("terminate-at-project-end", {}), false);
});

test("terminate-at-project-end stops only when no work remains", () => {
  assert.equal(
    shouldStopVmAtRunEnd("terminate-at-project-end", { hasRemainingWork: false }),
    true,
  );
  assert.equal(
    shouldStopVmAtRunEnd("terminate-at-project-end", { hasRemainingWork: true }),
    false,
  );
});

test("fresh-per-task and persistent never stop eagerly at run end", () => {
  assert.equal(shouldStopVmAtRunEnd("fresh-per-task", { hasRemainingWork: false }), false);
  assert.equal(shouldStopVmAtRunEnd("persistent", { hasRemainingWork: false }), false);
});
