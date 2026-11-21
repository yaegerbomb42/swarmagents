import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { middleware } from "../../../middleware";
import { USER_HEADER } from "../../../lib/auth";

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/logout", {
    method: "POST",
    headers: { ...headers },
  });
}

test("POST /api/logout clears the session cookie with maxAge: 0", async () => {
  const req = request({ [USER_HEADER]: "local_alice@example.com" });
  const res = await POST(req);
  assert.equal(res.status, 200);

  const json = (await res.json()) as { ok: boolean };
  assert.equal(json.ok, true);

  const sc = res.headers.get("set-cookie") ?? "";
  assert.ok(sc.includes("swarm_session="), `expected swarm_session cookie, got: ${sc}`);
  assert.ok(sc.includes("Max-Age=0"), `expected Max-Age=0 in Set-Cookie: ${sc}`);
  assert.ok(sc.includes("Path=/"), `expected Path=/ in Set-Cookie: ${sc}`);
  assert.ok(sc.includes("HttpOnly"), `expected HttpOnly in Set-Cookie: ${sc}`);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("POST /api/logout succeeds when unauthenticated (not an account oracle)", async () => {
  const req = request();
  const res = await POST(req);
  assert.equal(res.status, 200);

  const json = (await res.json()) as { ok: boolean };
  assert.equal(json.ok, true);

  const sc = res.headers.get("set-cookie") ?? "";
  assert.ok(sc.includes("Max-Age=0"), `expected Max-Age=0 in Set-Cookie: ${sc}`);
});

test("POST /api/logout is protected by middleware CSRF cross-site check", async () => {
  const req = new NextRequest("http://localhost/api/logout", {
    method: "POST",
    headers: {
      origin: "http://evil.example.com",
      host: "localhost",
    },
  });
  const res = middleware(req);
  assert.equal(res.status, 403);
  const json = (await res.json()) as { error: string };
  assert.equal(json.error, "Cross-site request blocked.");
});

test("POST /api/logout is accessible through middleware for same-origin callers", async () => {
  const req = new NextRequest("http://localhost/api/logout", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      host: "localhost",
    },
  });
  const res = middleware(req);
  // Same-origin allowed through to route handler (status is not 401 or 403)
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});
