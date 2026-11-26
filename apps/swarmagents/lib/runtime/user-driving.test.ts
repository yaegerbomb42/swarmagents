import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllUserDrivingForTests,
  DEFAULT_USER_DRIVING_IDLE_MS,
  handbackUserDriving,
  isUserDriving,
  setUserDriving,
} from "./user-driving";

test.afterEach(() => {
  clearAllUserDrivingForTests();
});

test("setUserDriving activates once, refreshes on activity, and auto-expires after 5m idle", () => {
  let clock = 1_000_000;
  const now = () => clock;

  const first = setUserDriving("run-1", now);
  assert.equal(first.newlyActivated, true);
  assert.equal(isUserDriving("run-1", now), true);

  clock += 30_000;
  const second = setUserDriving("run-1", now);
  assert.equal(second.newlyActivated, false);
  assert.equal(second.startedAt, 1_000_000);

  // Still active just before 5m idle.
  clock += DEFAULT_USER_DRIVING_IDLE_MS - 1;
  assert.equal(isUserDriving("run-1", now), true);

  // Expires at 5m idle.
  clock += 1;
  assert.equal(isUserDriving("run-1", now), false);
});

test("handbackUserDriving clears the flag and formats duration note", () => {
  let clock = 10_000;
  const now = () => clock;
  setUserDriving("run-2", now);
  clock += 42_000;
  const res = handbackUserDriving("run-2", now);
  assert.equal(res.wasDriving, true);
  assert.equal(res.durationSec, 42);
  assert.match(res.note, /User controlled the desktop for 42s/);
  assert.match(res.note, /Call describe_screen before acting/);
  assert.equal(isUserDriving("run-2", now), false);
});
