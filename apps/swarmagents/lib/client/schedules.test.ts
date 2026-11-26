import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULES_ENDPOINT,
  buildScheduleFromRunInput,
  createScheduleFromRun,
  unreadScheduledRuns,
  type ScheduleSummary,
} from "./schedules";

test("buildScheduleFromRunInput derives concise name and clamps interval", () => {
  const long = "Check production error logs and summarize any new 500s across services\nMore details";
  const built = buildScheduleFromRunInput(long, 2);
  assert.equal(built.intervalMinutes, 5);
  assert.ok(built.name.length <= 48);
  assert.ok(built.name.endsWith("..."));
  assert.equal(built.prompt, long);
});

test("createScheduleFromRun posts to /api/runtime/schedules and returns created schedule", async () => {
  let seenUrl = "";
  let seenBody = "";
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        schedule: {
          id: "sched_1",
          name: "Daily check",
          prompt: "Daily check",
          intervalMinutes: 60,
          enabled: true,
          nextRunAt: 1000,
        },
      }),
      { status: 201 },
    );
  }) as typeof fetch;

  const res = await createScheduleFromRun({ prompt: "Daily check", intervalMinutes: 60 }, fakeFetch);
  assert.equal(seenUrl, SCHEDULES_ENDPOINT);
  assert.deepEqual(JSON.parse(seenBody), { name: "Daily check", prompt: "Daily check", intervalMinutes: 60 });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.schedule.id, "sched_1");
});

test("unreadScheduledRuns filters out seen run IDs and sorts newest first", () => {
  const schedules: ScheduleSummary[] = [
    { id: "s1", name: "Older", prompt: "a", intervalMinutes: 60, enabled: true, nextRunAt: 1, lastRunId: "r1", lastRunAt: 100 },
    { id: "s2", name: "Seen", prompt: "b", intervalMinutes: 60, enabled: true, nextRunAt: 1, lastRunId: "r2", lastRunAt: 300 },
    { id: "s3", name: "Newest", prompt: "c", intervalMinutes: 60, enabled: true, nextRunAt: 1, lastRunId: "r3", lastRunAt: 200 },
    { id: "s4", name: "NeverRan", prompt: "d", intervalMinutes: 60, enabled: true, nextRunAt: 1 },
  ];
  const unread = unreadScheduledRuns(schedules, ["r2"]);
  assert.deepEqual(
    unread.map((u) => u.runId),
    ["r3", "r1"],
  );
});
