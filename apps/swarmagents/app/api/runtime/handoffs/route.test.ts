/**
 * ask_human_desktop handoffs API tests.
 *
 * GET returns only the caller's unresolved handoffs (so a reload can restore
 * the "Take the Wheel" card); POST hands the desktop back and resolves the
 * paused run. Handoffs are scoped to their owner and can only be handed back
 * once while pending.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { HandoffStore, setHandoffStoreForTesting } from "../../../../lib/harness/handoffs";

let clock = 1_000;
const store = new HandoffStore({ persist: false, ttlMs: 60_000, now: () => (clock += 1) });
setHandoffStoreForTesting(store);

after(() => {
  store.clear();
  setHandoffStoreForTesting(null);
});

interface TestInit {
  method?: string;
  body?: string;
}

function request(url: string, init: TestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  if (init.body) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body ? { body: init.body } : {}),
    headers,
  });
}

function handoff(overrides: Partial<{ id: string; runId: string; userId: string; reason: string }> = {}) {
  return store.create({
    id: overrides.id ?? "h_route",
    runId: overrides.runId ?? "run_1",
    userId: overrides.userId ?? "alice",
    reason: overrides.reason ?? "CAPTCHA",
    description: "solve it",
  });
}

test("handoffs API: unauthenticated requests are rejected", async () => {
  assert.equal((await GET(request("/api/runtime/handoffs", {}, null))).status, 401);
  assert.equal(
    (await POST(request("/api/runtime/handoffs", { method: "POST", body: "{}" }, null))).status,
    401,
  );
});

test("handoffs API: GET lists only the caller's pending handoffs, newest first", async () => {
  store.clear();
  handoff({ id: "h_a", runId: "run_1", userId: "alice", reason: "First?" });
  handoff({ id: "h_b", runId: "run_1", userId: "alice", reason: "Second?" });
  handoff({ id: "h_other", runId: "run_2", userId: "bob", reason: "Bob's?" });

  const res = await GET(request("/api/runtime/handoffs?runId=run_1"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { handoffs: Array<{ id: string; reason: string; description: string }> };
  assert.deepEqual(body.handoffs.map((h) => h.id), ["h_b", "h_a"]);
  assert.equal(body.handoffs[0].reason, "Second?");
  assert.equal(body.handoffs[0].description, "solve it");
  // No user ids leak to the client.
  assert.equal(Object.keys(body.handoffs[0]).includes("userId"), false);
});

test("handoffs API: GET for another user never returns the handoff", async () => {
  store.clear();
  handoff({ id: "h_private", userId: "alice" });
  const res = await GET(request("/api/runtime/handoffs", {}, "bob"));
  const body = (await res.json()) as { handoffs: unknown[] };
  assert.deepEqual(body.handoffs, []);
});

test("handoffs API: POST hands the desktop back and resolves the waiter", async () => {
  store.clear();
  const h = handoff({ id: "h_handback" });
  const waiter = store.waitFor(h.id);

  const res = await POST(request("/api/runtime/handoffs", { method: "POST", body: JSON.stringify({ id: h.id }) }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; status: string };
  assert.equal(body.ok, true);
  assert.equal(body.status, "answered");
  assert.deepEqual(await waiter, { status: "answered" });
  assert.equal(store.get(h.id)?.status, "answered");
});

test("handoffs API: validates the body", async () => {
  const bad = ["{not json", JSON.stringify([]), JSON.stringify({})];
  for (const body of bad) {
    const res = await POST(request("/api/runtime/handoffs", { method: "POST", body }));
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx for ${body}, got ${res.status}`);
  }
});

test("handoffs API: another user cannot hand back, and a second handback is a conflict", async () => {
  store.clear();
  const h = handoff({ id: "h_owned", userId: "alice" });
  const foreign = await POST(
    request("/api/runtime/handoffs", { method: "POST", body: JSON.stringify({ id: h.id }) }, "bob"),
  );
  assert.equal(foreign.status, 404);
  assert.equal(store.get(h.id)?.status, "pending");

  const first = await POST(request("/api/runtime/handoffs", { method: "POST", body: JSON.stringify({ id: h.id }) }));
  assert.equal(first.status, 200);

  const second = await POST(request("/api/runtime/handoffs", { method: "POST", body: JSON.stringify({ id: h.id }) }));
  assert.equal(second.status, 409);
  assert.equal(store.get(h.id)?.status, "answered");
});

test("handoffs API: the body size cap is enforced", async () => {
  const res = await POST(
    request("/api/runtime/handoffs", {
      method: "POST",
      body: JSON.stringify({ id: "h_x", pad: "x".repeat(8 * 1024) }),
    }),
  );
  assert.equal(res.status, 413);
});
