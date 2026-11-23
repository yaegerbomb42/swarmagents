// Tests for POST /api/runtime/watchers body parsing: an oversized body
// is rejected with 413 before any rule is stored, a malformed body with
// 400, and an unauthenticated caller with 401.

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { DEFAULT_MAX_JSON_BODY_BYTES } from "../../../../lib/http";

function post(body: string, user: string | null = "alice"): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (user !== null) headers.set("x-swarm-user", user);
  return POST(
    new NextRequest("http://localhost/api/runtime/watchers", {
      method: "POST",
      headers,
      body,
    }),
  );
}

test("watchers rejects an oversized body with 413", async () => {
  const huge = JSON.stringify({
    id: "rule-1",
    kind: "cron",
    roleId: "r1",
    prompt: "hi",
    toolAllowlist: ["read"],
    padding: "x".repeat(DEFAULT_MAX_JSON_BODY_BYTES + 1024),
  });
  const res = await post(huge);
  assert.equal(res.status, 413);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /too large/i);
});

test("watchers rejects a malformed body with 400", async () => {
  const res = await post("{not json");
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error?: string };
  assert.equal(data.error, "Invalid JSON.");
});

test("watchers rejects an unauthenticated caller with 401", async () => {
  const res = await post(JSON.stringify({}), null);
  assert.equal(res.status, 401);
});
