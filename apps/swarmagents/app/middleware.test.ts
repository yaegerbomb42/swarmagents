/**
 * Middleware local-mode navigation tests (morning-01 audit).
 *
 * Regression: in local mode a browser navigation to http://localhost:<port>/
 * used to 308-redirect to 127.0.0.1 via `new URL(req.url)` — but Next.js
 * relativizes middleware redirects against the request's internal URL (the
 * server binds 0.0.0.0, so the redirect target IS the internal origin) and
 * collapsed it to a bare "/" that the browser resolves against localhost:
 * an infinite self-redirect loop, so the home page never loaded in a browser
 * on localhost. Canonicalization moved client-side (app/layout.tsx); the
 * middleware must now let localhost document navigations through untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

// Local mode is the default (no SWARM_SERVER_MODE); make the test
// independent of whatever env the runner was started with.
delete process.env.SWARM_SERVER_MODE;

function navigate(url: string): NextRequest {
  return new NextRequest(url, { headers: { "sec-fetch-mode": "navigate" } });
}

test("local mode: localhost document navigation is NOT redirected", () => {
  const res = middleware(navigate("http://localhost:3101/"));
  assert.notEqual(res.status, 308, "localhost navigation must not 308");
  assert.notEqual(res.status, 301, "localhost navigation must not 301");
  assert.notEqual(res.status, 302, "localhost navigation must not 302");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
});

test("local mode: 127.0.0.1 document navigation passes through", () => {
  const res = middleware(navigate("http://127.0.0.1:3101/"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
});

test("local mode: localhost API fetch keeps working (no redirect)", () => {
  const res = middleware(
    new NextRequest("http://localhost:3101/api/health", { headers: { "sec-fetch-mode": "cors" } }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
});
