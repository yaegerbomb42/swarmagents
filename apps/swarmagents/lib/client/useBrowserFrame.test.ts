/**
 * Unit tests for useBrowserFrame's polling timing logic. The hook's scheduler
 * is extracted into pure helpers (browserPollSchedule, nextBrowserPollDelayMs,
 * recordBrowserPollOutcome) so the schedule can be tested without timers,
 * fetch mocks, or a DOM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_POLL_INTERVAL_MS,
  BROWSER_POLL_MAX_BACKOFF_MS,
  browserFrameUrl,
  browserPollSchedule,
  initialBrowserPollState,
  nextBrowserPollDelayMs,
  recordBrowserPollOutcome,
} from "./useBrowserFrame";

test("polls at the base interval while ticks succeed", () => {
  // A steady stream of good ticks (including the 404 "no frame yet" case
  // counting as a clean tick) stays at the modest 1s cadence.
  assert.deepEqual(browserPollSchedule(["ok", "ok", "ok", "ok"]), [
    BROWSER_POLL_INTERVAL_MS,
    BROWSER_POLL_INTERVAL_MS,
    BROWSER_POLL_INTERVAL_MS,
    BROWSER_POLL_INTERVAL_MS,
  ]);
});

test("a 404 (no frame yet) does not count as a failure", () => {
  // The frame route 404s until the first capture; the view must keep polling
  // at the base interval rather than backing off.
  const schedule = browserPollSchedule(["ok", "ok", "fail"]);
  assert.equal(schedule[0], BROWSER_POLL_INTERVAL_MS);
  assert.equal(schedule[1], BROWSER_POLL_INTERVAL_MS);
  // A failure right after resets the streak: the next delay is back to base.
  assert.equal(schedule[2], backoffDelay(0));
});

test("backs off exponentially after consecutive failures", () => {
  // The first failure's next tick is one base interval (backoff attempt 0);
  // each further failure doubles until the cap.
  const schedule = browserPollSchedule(["fail", "fail", "fail", "fail"]);
  assert.deepEqual(schedule, [
    backoffDelay(0),
    backoffDelay(0),
    backoffDelay(1),
    backoffDelay(2),
  ]);
});

test("caps the failure backoff", () => {
  const capped = ["fail", "fail", "fail", "fail", "fail", "fail", "fail"] as const;
  const schedule = browserPollSchedule(capped);
  assert.equal(schedule[schedule.length - 1], BROWSER_POLL_MAX_BACKOFF_MS);
  // A long failure run never exceeds the cap.
  assert.ok(schedule.every((d) => d <= BROWSER_POLL_MAX_BACKOFF_MS));
});

test("a success resets the failure streak", () => {
  // fail, fail (backoff growing), then ok: the delay scheduled *after* the ok
  // returns to base (the streak reset), even when one more failure follows.
  const schedule = browserPollSchedule(["fail", "fail", "ok", "fail"]);
  assert.equal(schedule[0], backoffDelay(0));
  assert.equal(schedule[1], backoffDelay(0));
  assert.equal(schedule[2], backoffDelay(1)); // streak 2 by the time the ok runs
  assert.equal(schedule[3], BROWSER_POLL_INTERVAL_MS); // reset → base again
});

test("recordBrowserPollOutcome folds outcomes deterministically", () => {
  const start = initialBrowserPollState();
  const afterFail = recordBrowserPollOutcome(start, false);
  assert.deepEqual(afterFail, { failStreak: 1 });
  const afterSecondFail = recordBrowserPollOutcome(afterFail, false);
  assert.deepEqual(afterSecondFail, { failStreak: 2 });
  assert.deepEqual(recordBrowserPollOutcome(afterSecondFail, true), start);
});

test("custom interval and backoff cap are honoured", () => {
  const opts = { intervalMs: 250, maxBackoffMs: 2000 };
  assert.equal(nextBrowserPollDelayMs(initialBrowserPollState(), opts), 250);
  // fail, fail, fail: 250 -> 250 -> 500.
  assert.deepEqual(browserPollSchedule(["fail", "fail", "fail"], opts), [250, 250, 500]);
  // A long run caps at 2000.
  const long = browserPollSchedule(
    ["fail", "fail", "fail", "fail", "fail", "fail", "fail"],
    opts,
  );
  assert.equal(long[long.length - 1], 2000);
});

test("browserFrameUrl encodes the run id", () => {
  assert.equal(browserFrameUrl("run_abc123"), "/api/runtime/browser/run_abc123/frame");
  assert.equal(
    browserFrameUrl("run with spaces"),
    "/api/runtime/browser/run%20with%20spaces/frame",
  );
});

/** First backoff delay from the base interval (one failure in the streak). */
function backoffDelay(n: number): number {
  // Mirrors backoffDelayMs: base = interval, doubled per extra failure, capped.
  return Math.min(BROWSER_POLL_INTERVAL_MS * 2 ** n, BROWSER_POLL_MAX_BACKOFF_MS);
}
