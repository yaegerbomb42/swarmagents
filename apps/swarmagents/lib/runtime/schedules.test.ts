/**
 * Tests for lib/runtime/schedules.ts: the cadence calculator, the per-user
 * atomic JSON store (bounds, isolation), the due-tick dispatcher (retry,
 * overlap lock), and the signed webhook trigger.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_INTERVAL_MINUTES,
  MAX_SCHEDULES_PER_USER,
  MIN_INTERVAL_MINUTES,
  checkScheduleWebhook,
  computeNextRunAt,
  configureSchedulesStore,
  createSchedule,
  deleteSchedule,
  fireSchedule,
  getSchedule,
  isScheduleDue,
  listSchedules,
  publicSchedule,
  tickDueSchedules,
  triggerScheduleByWebhook,
  updateSchedule,
  type Schedule,
  type ScheduleEngineDeps,
} from "./schedules";

const T0 = 1_780_000_000_000;

function freshStore(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedules-test-"));
  configureSchedulesStore(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sch_00000000-0000-0000-0000-000000000001",
    userId: "alice",
    name: "Morning brief",
    prompt: "Summarize what changed overnight.",
    intervalMinutes: 60,
    enabled: true,
    webhookSecret: "secret-1",
    nextRunAt: T0,
    createdAt: T0 - 3_600_000,
    updatedAt: T0 - 3_600_000,
    ...overrides,
  };
}

function fakeDeps(options?: {
  accept?: boolean;
  error?: string;
}): { deps: ScheduleEngineDeps; starts: { userId: string; prompt: string }[]; ensures: string[] } {
  const starts: { userId: string; prompt: string }[] = [];
  const ensures: string[] = [];
  const deps: ScheduleEngineDeps = {
    ensureVm: async (userId) => {
      ensures.push(userId);
    },
    startRun: (userId, input) => {
      starts.push({ userId, prompt: input.prompt });
      if (options?.accept === false) {
        return { accepted: false, runId: "", queued: false, error: options.error ?? "run refused" };
      }
      return { accepted: true, runId: `run_${starts.length}`, queued: false };
    },
    now: () => T0,
  };
  return { deps, starts, ensures };
}

// ---- cadence ----

test("computeNextRunAt lands one interval after the last run", () => {
  assert.equal(computeNextRunAt(T0, 60, T0), T0 + 3_600_000);
  assert.equal(computeNextRunAt(T0, 5, T0), T0 + 300_000);
});

test("computeNextRunAt catches up past now without looping", () => {
  // A week of downtime at a 5-minute cadence: the next tick is the first
  // interval boundary strictly after now, computed arithmetically.
  const weekLater = T0 + 7 * 24 * 3_600_000;
  const next = computeNextRunAt(T0, 5, weekLater);
  assert.ok(next > weekLater);
  assert.ok(next - weekLater <= 300_000);
  assert.equal((next - T0) % 300_000, 0);
});

test("computeNextRunAt never returns a past tick", () => {
  assert.ok(computeNextRunAt(T0 - 1_000, 60, T0) > T0);
});

test("isScheduleDue requires enabled and a reached nextRunAt", () => {
  assert.equal(isScheduleDue(makeSchedule({ nextRunAt: T0 }), T0), true);
  assert.equal(isScheduleDue(makeSchedule({ nextRunAt: T0 + 1 }), T0), false);
  assert.equal(isScheduleDue(makeSchedule({ enabled: false, nextRunAt: T0 }), T0), false);
});

// ---- store ----

test("create/list/get round-trips and the first tick is one interval out", (t) => {
  freshStore(t);
  const created = createSchedule("alice", { name: "Brief", prompt: "Do the brief.", intervalMinutes: 30 }, T0);
  assert.equal(created.userId, "alice");
  assert.equal(created.enabled, true);
  assert.equal(created.nextRunAt, T0 + 30 * 60_000);
  assert.match(created.id, /^sch_/);
  assert.equal(created.webhookSecret.length, 48);
  assert.equal(listSchedules("alice").length, 1);
  assert.equal(getSchedule("alice", created.id)?.name, "Brief");
  assert.equal(getSchedule("bob", created.id), null);
  assert.equal(listSchedules("bob").length, 0);
});

test("create rejects intervals below the 5-minute minimum and above the week cap", (t) => {
  freshStore(t);
  assert.throws(
    () => createSchedule("alice", { name: "x", prompt: "y", intervalMinutes: 4 }, T0),
    /at least 5 minutes/,
  );
  assert.throws(
    () => createSchedule("alice", { name: "x", prompt: "y", intervalMinutes: MAX_INTERVAL_MINUTES + 1 }, T0),
    /at most 10080 minutes/,
  );
  assert.throws(
    () => createSchedule("alice", { name: "x", prompt: "y", intervalMinutes: 5.5 }, T0),
    /whole number/,
  );
  assert.equal(createSchedule("alice", { name: "x", prompt: "y", intervalMinutes: MIN_INTERVAL_MINUTES }, T0).intervalMinutes, 5);
});

test("create rejects an empty name or prompt", (t) => {
  freshStore(t);
  assert.throws(() => createSchedule("alice", { name: "  ", prompt: "y", intervalMinutes: 60 }, T0));
  assert.throws(() => createSchedule("alice", { name: "x", prompt: "", intervalMinutes: 60 }, T0));
});

test("create enforces the 20-per-user cap without touching other users", (t) => {
  freshStore(t);
  for (let i = 0; i < MAX_SCHEDULES_PER_USER; i++) {
    createSchedule("alice", { name: `s${i}`, prompt: "p", intervalMinutes: 60 }, T0);
  }
  assert.throws(() => createSchedule("alice", { name: "one too many", prompt: "p", intervalMinutes: 60 }, T0), /At most 20/);
  // Another user still has a full allowance.
  createSchedule("bob", { name: "b0", prompt: "p", intervalMinutes: 60 }, T0);
  assert.equal(listSchedules("bob").length, 1);
});

test("update pauses/resumes and re-bases the next tick when the interval changes", (t) => {
  freshStore(t);
  const created = createSchedule("alice", { name: "Brief", prompt: "Do it.", intervalMinutes: 60 }, T0);
  const paused = updateSchedule("alice", created.id, { enabled: false }, T0 + 1_000);
  assert.equal(paused?.enabled, false);
  assert.equal(paused?.nextRunAt, created.nextRunAt);
  const retimed = updateSchedule("alice", created.id, { intervalMinutes: 30 }, T0 + 2_000);
  assert.equal(retimed?.intervalMinutes, 30);
  assert.equal(retimed?.nextRunAt, T0 + 2_000 + 30 * 60_000);
  const resumed = updateSchedule("alice", created.id, { enabled: true }, T0 + 3_000);
  assert.equal(resumed?.enabled, true);
});

test("update and delete are per-user: another user's schedule is invisible", (t) => {
  freshStore(t);
  const created = createSchedule("alice", { name: "Brief", prompt: "Do it.", intervalMinutes: 60 }, T0);
  assert.equal(updateSchedule("bob", created.id, { enabled: false }, T0), null);
  assert.equal(deleteSchedule("bob", created.id), false);
  assert.equal(getSchedule("alice", created.id)?.name, "Brief");
  assert.equal(updateSchedule("alice", "sch_00000000-0000-0000-0000-000000000099", { enabled: false }, T0), null);
  assert.equal(deleteSchedule("alice", created.id), true);
  assert.equal(listSchedules("alice").length, 0);
  assert.equal(deleteSchedule("alice", created.id), false);
});

test("update rejects an empty patch and an out-of-bounds interval", (t) => {
  freshStore(t);
  const created = createSchedule("alice", { name: "Brief", prompt: "Do it.", intervalMinutes: 60 }, T0);
  assert.throws(() => updateSchedule("alice", created.id, {}, T0), /Nothing to update/);
  assert.throws(() => updateSchedule("alice", created.id, { intervalMinutes: 1 }, T0), /at least 5 minutes/);
});

test("publicSchedule never exposes the webhook secret", (t) => {
  freshStore(t);
  const created = createSchedule("alice", { name: "Brief", prompt: "Do it.", intervalMinutes: 60 }, T0);
  const pub = publicSchedule(created);
  assert.equal("webhookSecret" in pub, false);
  assert.equal(pub.hasWebhookSecret, true);
  assert.equal(pub.id, created.id);
});

// ---- tick ----

test("tickDueSchedules fires due schedules and skips paused and not-due ones", async (t) => {
  freshStore(t);
  const due = createSchedule("alice", { name: "Due", prompt: "Run now.", intervalMinutes: 60 }, T0 - 3_600_000);
  const paused = createSchedule("alice", { name: "Paused", prompt: "Later.", intervalMinutes: 60 }, T0 - 3_600_000);
  updateSchedule("alice", paused.id, { enabled: false }, T0);
  createSchedule("alice", { name: "Future", prompt: "Not yet.", intervalMinutes: 60 }, T0);
  const { deps, starts, ensures } = fakeDeps();
  const results = await tickDueSchedules(deps, T0);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.scheduleId, due.id);
  assert.equal(results[0]?.fired, true);
  assert.equal(starts.length, 1);
  assert.deepEqual(ensures, ["alice"]);
  assert.match(starts[0]?.prompt ?? "", /Trigger: schedule Due/);
  const stored = getSchedule("alice", due.id);
  assert.equal(stored?.lastRunId, results[0]?.runId);
  assert.equal(stored?.lastRunAt, T0);
  assert.equal(stored?.nextRunAt, T0 + 3_600_000);
});

test("a refused fire leaves nextRunAt untouched so the next tick retries", async (t) => {
  freshStore(t);
  const due = createSchedule("alice", { name: "Due", prompt: "Run now.", intervalMinutes: 60 }, T0 - 3_600_000);
  const { deps } = fakeDeps({ accept: false, error: "VM at capacity" });
  const results = await tickDueSchedules(deps, T0);
  assert.equal(results[0]?.fired, false);
  assert.equal(results[0]?.error, "VM at capacity");
  const stored = getSchedule("alice", due.id);
  assert.equal(stored?.nextRunAt, due.nextRunAt);
  assert.equal(stored?.lastRunId, undefined);
});

test("overlapping ticks share one run and never double-fire", async (t) => {
  freshStore(t);
  createSchedule("alice", { name: "Due", prompt: "Run now.", intervalMinutes: 60 }, T0 - 3_600_000);
  const { deps, starts } = fakeDeps();
  // The first tick yields at its first await; the second call must share the
  // in-flight tick instead of starting a second one.
  const first = tickDueSchedules(deps, T0);
  const second = tickDueSchedules(deps, T0);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a.length, 1);
  assert.equal(starts.length, 1);
});

test("fireSchedule refuses a paused schedule without waking the VM", async () => {
  const { deps, starts, ensures } = fakeDeps();
  const result = await fireSchedule(makeSchedule({ enabled: false }), deps);
  assert.equal(result.fired, false);
  assert.equal(result.error, "schedule paused");
  assert.equal(starts.length, 0);
  assert.equal(ensures.length, 0);
});

// ---- webhook ----

test("checkScheduleWebhook accepts only the exact secret", (t) => {
  freshStore(t);
  const created = createSchedule("alice", { name: "Brief", prompt: "Do it.", intervalMinutes: 60 }, T0);
  assert.equal(checkScheduleWebhook("alice", created.id, created.webhookSecret), "ok");
  assert.equal(checkScheduleWebhook("alice", created.id, "wrong"), "unauthorized");
  assert.equal(checkScheduleWebhook("alice", created.id, ""), "unauthorized");
  assert.equal(checkScheduleWebhook("bob", created.id, created.webhookSecret), "not found");
  assert.equal(checkScheduleWebhook("alice", "not-an-id", created.webhookSecret), "invalid id");
});

test("a webhook fire records the run but leaves the cadence alone", async (t) => {
  freshStore(t);
  const created = createSchedule("alice", { name: "Brief", prompt: "Do it.", intervalMinutes: 60 }, T0);
  const { deps, starts } = fakeDeps();
  const result = await triggerScheduleByWebhook("alice", created.id, created.webhookSecret, deps);
  assert.equal(result.fired, true);
  assert.equal(starts.length, 1);
  const stored = getSchedule("alice", created.id);
  assert.equal(stored?.lastRunId, result.runId);
  assert.equal(stored?.lastRunAt, T0);
  assert.equal(stored?.nextRunAt, created.nextRunAt);
});

test("a webhook fire with a wrong secret does not start a run", async (t) => {
  freshStore(t);
  const created = createSchedule("alice", { name: "Brief", prompt: "Do it.", intervalMinutes: 60 }, T0);
  const { deps, starts } = fakeDeps();
  const result = await triggerScheduleByWebhook("alice", created.id, "wrong", deps);
  assert.equal(result.fired, false);
  assert.equal(result.error, "unauthorized");
  assert.equal(starts.length, 0);
});
