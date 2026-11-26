import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllUserDrivingForTests,
  clearUserDriving,
  gateUserDriving,
  takeHandbackNote,
  USER_DRIVING_DENY_REASON,
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

test("gateUserDriving: no takeover and no note means no opinion", async () => {
  assert.equal(await gateUserDriving("run-free"), null);
});

test("gateUserDriving holds while the user drives, then answers once with the hand-back note", async () => {
  let clock = 0;
  const now = () => clock;
  setUserDriving("run-h", now);
  let slept = 0;
  const sleep = async (ms: number) => {
    slept += ms;
    clock += ms;
    // The user hands back after 3 s of the agent waiting.
    if (slept >= 3_000 && isUserDriving("run-h", now)) handbackUserDriving("run-h", now);
  };
  const verdict = await gateUserDriving("run-h", { now, sleep, pollMs: 500, maxWaitMs: 60_000 });
  assert.equal(verdict?.decision, "deny");
  assert.match(verdict?.reason ?? "", /User controlled the desktop for 3s/);
  assert.equal(slept, 3_000);
  // One-shot: the next action goes through.
  assert.equal(await gateUserDriving("run-h", { now, sleep }), null);
});

test("gateUserDriving gives up with a wait reason at maxWaitMs, keeping the takeover", async () => {
  let clock = 0;
  const now = () => clock;
  setUserDriving("run-w", now);
  const sleep = async (ms: number) => {
    clock += ms;
    setUserDriving("run-w", now); // the user keeps clicking
  };
  const verdict = await gateUserDriving("run-w", { now, sleep, pollMs: 1_000, maxWaitMs: 10_000 });
  assert.deepEqual(verdict, { decision: "deny", reason: USER_DRIVING_DENY_REASON });
  assert.equal(isUserDriving("run-w", now), true);
});

test("gateUserDriving stops waiting when the run is cancelled", async () => {
  let clock = 0;
  const now = () => clock;
  setUserDriving("run-c", now);
  const controller = new AbortController();
  const sleep = async (ms: number) => {
    clock += ms;
    controller.abort();
  };
  const verdict = await gateUserDriving("run-c", { now, sleep, signal: controller.signal });
  assert.equal(verdict?.decision, "deny");
  assert.match(verdict?.reason ?? "", /cancelled/);
});

test("a takeover that idle-expires still gets a re-inspect note; clearUserDriving forgets everything", async () => {
  let clock = 0;
  const now = () => clock;
  setUserDriving("run-e", now);
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const verdict = await gateUserDriving("run-e", { now, sleep, pollMs: 60_000, maxWaitMs: 10 * 60_000 });
  assert.match(verdict?.reason ?? "", /Call describe_screen before acting/);

  setUserDriving("run-x", now);
  handbackUserDriving("run-x", now);
  clearUserDriving("run-x");
  assert.equal(takeHandbackNote("run-x"), undefined);
});
