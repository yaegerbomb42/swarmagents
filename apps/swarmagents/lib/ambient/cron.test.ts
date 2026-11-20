import test from "node:test";
import assert from "node:assert/strict";
import { cronBucket, cronMatches } from "./cron";

test("cronBucket uses the timezone's year across a New Year boundary", () => {
  // 2027-01-01T02:00:00Z is still 2026-12-31 21:00 in New York (UTC-5).
  // The UTC year (2027) and the local year (2026) differ here.
  const instant = new Date("2027-01-01T02:00:00.000Z");
  const bucket = cronBucket(instant, "America/New_York");
  assert.equal(bucket, "2026-12-31T21:00");
});

test("cronBucket stays stable when local and UTC years agree", () => {
  const instant = new Date("2026-06-15T14:30:00.000Z");
  assert.equal(cronBucket(instant, "America/New_York"), "2026-06-15T10:30");
  assert.equal(cronBucket(instant), "2026-06-15T14:30");
});

test("*/n step matches every nth value starting at the field minimum", () => {
  const at = (minute: number) => new Date(`2026-11-16T09:${String(minute).padStart(2, "0")}:00.000Z`);
  assert.equal(cronMatches("*/5 * * * *", at(0)), true);
  assert.equal(cronMatches("*/5 * * * *", at(5)), true);
  assert.equal(cronMatches("*/5 * * * *", at(55)), true);
  assert.equal(cronMatches("*/5 * * * *", at(3)), false);
  assert.equal(cronMatches("*/5 * * * *", at(56)), false);
});

test("*/n steps the day field from its own minimum of 1", () => {
  // */2 across days 1..31 must hit odd days only, not 0,2,4...
  assert.equal(cronMatches("0 0 */2 * *", new Date("2026-11-01T00:00:00.000Z")), true);
  assert.equal(cronMatches("0 0 */2 * *", new Date("2026-11-02T00:00:00.000Z")), false);
  assert.equal(cronMatches("0 0 */2 * *", new Date("2026-11-03T00:00:00.000Z")), true);
});

test("a-b/n step matches within the range only", () => {
  const at = (minute: number) => new Date(`2026-11-16T09:${String(minute).padStart(2, "0")}:00.000Z`);
  for (const minute of [1, 3, 5, 7, 9]) {
    assert.equal(cronMatches("1-10/2 * * * *", at(minute)), true, `minute ${minute} should match`);
  }
  for (const minute of [0, 2, 4, 10, 11]) {
    assert.equal(cronMatches("1-10/2 * * * *", at(minute)), false, `minute ${minute} should not match`);
  }
});

test("steps compose with ranges and lists in other fields", () => {
  // Every 15 minutes during business hours.
  assert.equal(cronMatches("*/15 9-17 * * 1-5", new Date("2026-11-16T09:45:00.000Z")), true);
  assert.equal(cronMatches("*/15 9-17 * * 1-5", new Date("2026-11-16T09:46:00.000Z")), false);
  // Step on hours, with an explicit minute.
  assert.equal(cronMatches("0 */6 * * *", new Date("2026-11-16T12:00:00.000Z")), true);
  assert.equal(cronMatches("0 */6 * * *", new Date("2026-11-16T13:00:00.000Z")), false);
});

test("invalid step expressions never match instead of throwing", () => {
  const at = new Date("2026-11-16T09:05:00.000Z");
  assert.equal(cronMatches("*/0 * * * *", at), false);
  assert.equal(cronMatches("*/ * * * *", at), false);
  assert.equal(cronMatches("5/2 * * * *", at), false);
  assert.equal(cronMatches("10-1/2 * * * *", at), false);
});