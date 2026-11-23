// Route-level tests for POST /api/team/<runId>/takeover.
//
// The takeover itself lives in lib/team/manager.ts (tested there); these
// tests cover the route wiring: auth, runId shape, bounded body parsing,
// agentId validation, and the 404 for an unknown run. A fresh TeamManager
// is injected per test, so no run state is needed for the 404 case.

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { DEFAULT_MAX_JSON_BODY_BYTES } from "@/lib/http";
import { TeamManager, setTeamManagerForTesting } from "@/lib/team/manager";

test.beforeEach(() => {
  setTeamManagerForTesting(new TeamManager());
});

test.afterEach(() => {
  setTeamManagerForTesting(null);
});

function post(
  runId: string,
  body: string,
  user: string | null = "alice",
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (user !== null) headers.set("x-swarm-user", user);
  return POST(
    new NextRequest(`http://localhost/api/team/${runId}/takeover`, {
      method: "POST",
      headers,
      body,
    }),
    { params: Promise.resolve({ runId }) },
  );
}

test("takeover rejects an unauthenticated caller with 401", async () => {
  const res = await post("team_abc123", JSON.stringify({ agentId: "lane-1" }), null);
  assert.equal(res.status, 401);
});

test("takeover rejects a malformed runId with 400", async () => {
  const res = await post("nope", JSON.stringify({ agentId: "lane-1" }));
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error?: string };
  assert.equal(data.error, "invalid runId");
});

test("takeover rejects malformed and empty bodies with 400", async () => {
  for (const bad of ["{not json", ""]) {
    const res = await post("team_abc123", bad);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error?: string };
    assert.equal(data.error, "Invalid JSON body.");
  }
});

test("takeover rejects an oversized body with 413", async () => {
  const huge = JSON.stringify({
    agentId: "lane-1",
    padding: "x".repeat(DEFAULT_MAX_JSON_BODY_BYTES + 1024),
  });
  const res = await post("team_abc123", huge);
  assert.equal(res.status, 413);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /too large/i);
});

test("takeover rejects a missing agentId with 400", async () => {
  const res = await post("team_abc123", JSON.stringify({}));
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error?: string };
  assert.equal(data.error, "agentId is required.");
});

test("takeover returns 404 for an unknown run", async () => {
  const res = await post("team_abc123", JSON.stringify({ agentId: "lane-1" }));
  assert.equal(res.status, 404);
  const data = (await res.json()) as { error?: string };
  assert.equal(data.error, "Run not found.");
});
