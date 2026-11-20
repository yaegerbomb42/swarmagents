import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { USER_HEADER } from "../../../lib/auth";

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/me", { headers });
}

test("GET /api/me returns the middleware-set user", async () => {
  const res = GET(request({ [USER_HEADER]: "local_alice@example.com" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    user: { id: "local_alice@example.com", email: "alice@example.com" },
  });
});

test("GET /api/me reports null when signed out", async () => {
  const res = GET(request());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: null });
});

test("GET /api/me never trusts a client-supplied user header", async () => {
  // A caller that fabricates x-swarm-user gets it echoed back as a *string*
  // identity (middleware overwrites this header, so a real deployment cannot
  // be spoofed — the route just reports what middleware decided).
  const res = GET(request({ "x-swarm-user": "mallory" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: { id: "mallory", email: "mallory@swarmagents.local" } });
});
