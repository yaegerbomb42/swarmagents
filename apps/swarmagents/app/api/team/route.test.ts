// Route-level tests for the Team Mode control plane (/api/team).
//
// The run lifecycle lives in lib/team/manager.ts (tested there); these
// tests cover the route wiring: auth on every method, body validation
// (size cap, JSON shape, prompt rules) on POST, and the empty/cancel
// branches on GET/DELETE. A fresh TeamManager is injected per test.
// The POST success path (which starts a real team run) is deliberately
// not exercised here.

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { DELETE, GET, POST } from "./route";
import { TeamManager, setTeamManagerForTesting } from "@/lib/team/manager";

test.beforeEach(() => {
  setTeamManagerForTesting(new TeamManager());
});

test.afterEach(() => {
  setTeamManagerForTesting(null);
});

function request(
  method: string,
  url: string,
  init: { body?: string; user?: string | null } = {},
): NextRequest {
  const headers = new Headers();
  if (init.user !== null && init.user !== undefined) headers.set("x-swarm-user", init.user);
  else if (init.user === undefined) headers.set("x-swarm-user", "alice");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

test("team GET rejects an unauthenticated caller with 401", async () => {
  const res = await GET(request("GET", "/api/team", { user: null }));
  assert.equal(res.status, 401);
});

test("team GET returns no run and no runs for a caller with nothing running", async () => {
  const res = await GET(request("GET", "/api/team"));
  assert.equal(res.status, 200);
  const data = (await res.json()) as { run: unknown; runs: unknown[] };
  assert.equal(data.run, null);
  assert.deepEqual(data.runs, []);
});

test("team POST rejects an unauthenticated caller with 401", async () => {
  const res = await POST(
    request("POST", "/api/team", { body: JSON.stringify({ prompt: "hi" }), user: null }),
  );
  assert.equal(res.status, 401);
});

test("team POST rejects malformed, non-object, and empty-prompt bodies with 400", async () => {
  const cases: Array<{ body: string; error: string }> = [
    { body: "{not json", error: "Invalid JSON body." },
    { body: JSON.stringify(["prompt"]), error: "Body must be a JSON object." },
    { body: JSON.stringify({}), error: "prompt is required." },
    { body: JSON.stringify({ prompt: "   " }), error: "prompt is required." },
  ];
  for (const { body, error } of cases) {
    const res = await POST(request("POST", "/api/team", { body }));
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error?: string };
    assert.equal(data.error, error);
  }
});

test("team POST rejects an over-long prompt with 400", async () => {
  const res = await POST(
    request("POST", "/api/team", { body: JSON.stringify({ prompt: "x".repeat(200_001) }) }),
  );
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error?: string };
  assert.equal(data.error, "prompt too long.");
});

test("team POST rejects an oversized body with 413", async () => {
  const res = await POST(
    request("POST", "/api/team", {
      body: JSON.stringify({ prompt: "x", padding: "x".repeat(256 * 1024) }),
    }),
  );
  assert.equal(res.status, 413);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /too large/i);
});

test("team DELETE rejects an unauthenticated caller with 401", async () => {
  const res = await DELETE(request("DELETE", "/api/team", { user: null }));
  assert.equal(res.status, 401);
});

test("team DELETE returns 404 when there is no team run to cancel", async () => {
  const res = await DELETE(request("DELETE", "/api/team"));
  assert.equal(res.status, 404);
  const data = (await res.json()) as { error?: string };
  assert.equal(data.error, "No team run to cancel.");
});
