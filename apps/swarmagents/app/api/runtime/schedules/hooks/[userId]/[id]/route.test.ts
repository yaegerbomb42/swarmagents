/**
 * Tests for POST /api/runtime/schedules/hooks/<userId>/<id>: secret-first
 * auth, identical 401s for unknown ids and wrong secrets, bounded bodies,
 * and the fire itself (including the paused-schedule 409).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  configureSchedulesStore,
  createSchedule,
  setScheduleEngineDepsForTesting,
  updateSchedule,
  type Schedule,
  type ScheduleEngineDeps,
} from "../../../../../../../lib/runtime/schedules";

let dir: string;
let schedule: Schedule;
let starts: { userId: string; prompt: string }[];

function fakeDeps(): ScheduleEngineDeps {
  return {
    ensureVm: async () => undefined,
    startRun: (userId, input) => {
      starts.push({ userId, prompt: input.prompt });
      return { accepted: true, runId: "run_sched_1", queued: false };
    },
    now: () => 1_780_000_000_000,
  };
}

function request(
  body: unknown,
  headers: Record<string, string> = {},
  json = true,
): NextRequest {
  return new NextRequest(`http://localhost/api/runtime/schedules/hooks/alice/${schedule.id}`, {
    method: "POST",
    headers: json
      ? { "content-type": "application/json", ...headers }
      : { "content-type": "text/plain", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function context(userId: string, id: string) {
  return { params: Promise.resolve({ userId, id }) };
}

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-hooks-route-"));
  configureSchedulesStore(dir);
  starts = [];
  setScheduleEngineDepsForTesting(fakeDeps());
  schedule = createSchedule(
    "alice",
    { name: "Brief", prompt: "Do the brief.", intervalMinutes: 60 },
    1_780_000_000_000,
  );
});

test.afterEach(() => {
  setScheduleEngineDepsForTesting(null);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("an oversized webhook body is rejected with 413", async () => {
  const big = JSON.stringify({ blob: "a".repeat(300_000) });
  assert.ok(Buffer.byteLength(big, "utf8") > 256 * 1024);
  const res = await POST(
    request(big, { "x-swarm-hook-secret": schedule.webhookSecret }),
    context("alice", schedule.id),
  );
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /too large/i);
});

test("a malformed JSON body is rejected with 400", async () => {
  const res = await POST(
    request("{not json", { "x-swarm-hook-secret": schedule.webhookSecret }),
    context("alice", schedule.id),
  );
  assert.equal(res.status, 400);
});

test("an empty body is rejected with 400", async () => {
  const res = await POST(
    request("", { "x-swarm-hook-secret": schedule.webhookSecret }),
    context("alice", schedule.id),
  );
  assert.equal(res.status, 400);
});

test("a malformed userId is rejected with a structured 400 before dispatch", async () => {
  const res = await POST(
    request({ ok: true }, { "x-swarm-hook-secret": schedule.webhookSecret }),
    context("user a", schedule.id),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /invalid/i);
});

test("a malformed id is rejected with a structured 400 before dispatch", async () => {
  const res = await POST(
    request({ ok: true }, { "x-swarm-hook-secret": schedule.webhookSecret }),
    context("alice", "bad id"),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /invalid/i);
});

test("unknown schedules and wrong secrets answer identically", async () => {
  const wrongSecret = await POST(
    request({}, { "x-swarm-hook-secret": "nope" }),
    context("alice", schedule.id),
  );
  const unknownId = await POST(
    request({}, { "x-swarm-hook-secret": schedule.webhookSecret }),
    context("alice", "sch_00000000-0000-0000-0000-000000000099"),
  );
  const unknownUser = await POST(
    request({}, { "x-swarm-hook-secret": schedule.webhookSecret }),
    context("user_z", schedule.id),
  );
  assert.equal(wrongSecret.status, 401);
  assert.equal(unknownId.status, 401);
  assert.equal(unknownUser.status, 401);
  const body = await wrongSecret.text();
  assert.equal(await unknownId.text(), body);
  assert.equal(await unknownUser.text(), body);
});

test("the secret is checked before the body is read", async () => {
  // Malformed body + wrong secret: the answer is 401, never a parse error.
  const res = await POST(
    request("{not json", { "x-swarm-hook-secret": "nope" }),
    context("alice", schedule.id),
  );
  assert.equal(res.status, 401);
});

test("a webhook with the right secret fires a run", async () => {
  const res = await POST(
    request({ ok: true }, { "x-swarm-hook-secret": schedule.webhookSecret }),
    context("alice", schedule.id),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok?: boolean; runId?: string };
  assert.equal(body.ok, true);
  assert.equal(body.runId, "run_sched_1");
  assert.equal(starts.length, 1);
  assert.match(starts[0]?.prompt ?? "", /Trigger: schedule Brief/);
});

test("a webhook for a paused schedule answers 409 and starts nothing", async () => {
  updateSchedule("alice", schedule.id, { enabled: false }, 1_780_000_000_000);
  const res = await POST(
    request({ ok: true }, { "x-swarm-hook-secret": schedule.webhookSecret }),
    context("alice", schedule.id),
  );
  assert.equal(res.status, 409);
  assert.equal(starts.length, 0);
});

test("the Bearer authorization header works as the secret", async () => {
  const res = await POST(
    request({ ok: true }, { authorization: `Bearer ${schedule.webhookSecret}` }),
    context("alice", schedule.id),
  );
  assert.equal(res.status, 200);
});
