/**
 * Tests for /api/runtime/schedules: auth, Zod/bounds validation, the
 * 20-per-user cap, per-user isolation, pause/resume/delete, and the
 * no-store + secret-handling rules.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { configureSchedulesStore } from "../../../../lib/runtime/schedules";
import { DEFAULT_MAX_JSON_BODY_BYTES } from "../../../../lib/http";
import { DELETE, GET, PATCH, POST } from "./route";

function freshStore(t: { after: (fn: () => void) => void }): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedules-route-test-"));
  configureSchedulesStore(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function req(
  method: string,
  body: unknown,
  user: string | null = "alice",
  query = "",
): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost/api/runtime/schedules${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function create(
  user = "alice",
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; data: Record<string, any> }> {
  const res = await POST(
    req("POST", { name: "Brief", prompt: "Do the brief.", intervalMinutes: 60, ...overrides }, user),
  );
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

test("GET requires sign-in and lists only the caller's schedules", async (t) => {
  freshStore(t);
  const anon = await GET(req("GET", undefined, null));
  assert.equal(anon.status, 401);
  const empty = await GET(req("GET", undefined, "alice"));
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("cache-control"), "no-store");
  assert.deepEqual(((await empty.json()) as { schedules: unknown[] }).schedules, []);
  await create("alice");
  await create("bob", { name: "Bob's", prompt: "Bob's run." });
  const alice = (await (await GET(req("GET", undefined, "alice"))).json()) as {
    schedules: { name: string }[];
  };
  assert.equal(alice.schedules.length, 1);
  assert.equal(alice.schedules[0]?.name, "Brief");
});

test("POST creates a schedule and returns the webhook secret exactly once", async (t) => {
  freshStore(t);
  const { status, data } = await create();
  assert.equal(status, 201);
  assert.equal(data.schedule.name, "Brief");
  assert.equal(data.schedule.enabled, true);
  assert.equal(typeof data.webhookSecret, "string");
  assert.equal(data.webhookSecret.length, 48);
  assert.equal("webhookSecret" in data.schedule, false);
  assert.equal(data.schedule.hasWebhookSecret, true);
  const listed = (await (await GET(req("GET", undefined, "alice"))).json()) as {
    schedules: Record<string, unknown>[];
  };
  assert.equal(listed.schedules.length, 1);
  assert.equal("webhookSecret" in (listed.schedules[0] ?? {}), false);
});

test("POST rejects bad input, malformed JSON, and oversized bodies", async (t) => {
  freshStore(t);
  const tooFast = await create("alice", { intervalMinutes: 4 });
  assert.equal(tooFast.status, 400);
  assert.match(tooFast.data.error ?? "", /at least 5 minutes/);
  const noPrompt = await create("alice", { prompt: "   " });
  assert.equal(noPrompt.status, 400);
  const malformed = await POST(req("POST", "{not json", "alice"));
  assert.equal(malformed.status, 400);
  const huge = await POST(
    req("POST", JSON.stringify({ name: "x", prompt: "y", intervalMinutes: 60, padding: "x".repeat(DEFAULT_MAX_JSON_BODY_BYTES + 1024) }), "alice"),
  );
  assert.equal(huge.status, 413);
  const anon = await POST(req("POST", { name: "x", prompt: "y", intervalMinutes: 60 }, null));
  assert.equal(anon.status, 401);
});

test("POST enforces the 20-per-user cap", async (t) => {
  freshStore(t);
  for (let i = 0; i < 20; i++) {
    const { status } = await create("alice", { name: `s${i}` });
    assert.equal(status, 201);
  }
  const over = await create("alice", { name: "one too many" });
  assert.equal(over.status, 400);
  assert.match(over.data.error ?? "", /At most 20/);
});

test("PATCH pauses and resumes, and rejects unknown ids and empty updates", async (t) => {
  freshStore(t);
  const { data } = await create();
  const id = data.schedule.id as string;
  const paused = await PATCH(req("PATCH", { enabled: false }, "alice", `?id=${id}`));
  assert.equal(paused.status, 200);
  assert.equal(((await paused.json()) as { schedule: { enabled: boolean } }).schedule.enabled, false);
  const resumed = await PATCH(req("PATCH", { enabled: true }, "alice", `?id=${id}`));
  assert.equal((((await resumed.json()) as { schedule: { enabled: boolean } }).schedule.enabled), true);
  const retimed = await PATCH(req("PATCH", { intervalMinutes: 120 }, "alice", `?id=${id}`));
  assert.equal(retimed.status, 200);
  assert.equal((((await retimed.json()) as { schedule: { intervalMinutes: number } }).schedule.intervalMinutes), 120);
  assert.equal((await PATCH(req("PATCH", {}, "alice", `?id=${id}`))).status, 400);
  assert.equal((await PATCH(req("PATCH", { intervalMinutes: 1 }, "alice", `?id=${id}`))).status, 400);
  assert.equal((await PATCH(req("PATCH", { enabled: true }, "alice", "?id=sch_00000000-0000-0000-0000-000000000099"))).status, 404);
  assert.equal((await PATCH(req("PATCH", { enabled: true }, "alice"))).status, 400);
  assert.equal((await PATCH(req("PATCH", { enabled: true }, null, `?id=${id}`))).status, 401);
});

test("PATCH and DELETE cannot touch another user's schedule", async (t) => {
  freshStore(t);
  const { data } = await create("alice");
  const id = data.schedule.id as string;
  assert.equal((await PATCH(req("PATCH", { enabled: false }, "bob", `?id=${id}`))).status, 404);
  assert.equal((await DELETE(req("DELETE", undefined, "bob", `?id=${id}`))).status, 404);
  const listed = (await (await GET(req("GET", undefined, "alice"))).json()) as {
    schedules: { enabled: boolean }[];
  };
  assert.equal(listed.schedules[0]?.enabled, true);
});

test("DELETE removes the schedule and a second delete is 404", async (t) => {
  freshStore(t);
  const { data } = await create();
  const id = data.schedule.id as string;
  const deleted = await DELETE(req("DELETE", undefined, "alice", `?id=${id}`));
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.equal((await DELETE(req("DELETE", undefined, "alice", `?id=${id}`))).status, 404);
  assert.equal((await DELETE(req("DELETE", undefined, "alice"))).status, 400);
  assert.equal((await DELETE(req("DELETE", undefined, null, `?id=${id}`))).status, 401);
  const listed = (await (await GET(req("GET", undefined, "alice"))).json()) as {
    schedules: unknown[];
  };
  assert.deepEqual(listed.schedules, []);
});
