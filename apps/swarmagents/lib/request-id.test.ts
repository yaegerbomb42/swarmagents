import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { POST as postTasks } from "../app/api/runtime/tasks/route";
import { POST as postLogin } from "../app/api/login/route";
import { GET as getProviders } from "../app/api/providers/route";
import {
  REQUEST_ID_HEADER,
  formatAccessLogLine,
  hashUserId,
  jsonErrorWithRequestId,
  resolveRequestId,
} from "./request-id";

test("resolveRequestId reuses safe inbound x-request-id and mints UUID for unsafe/missing", () => {
  assert.equal(resolveRequestId(new Headers({ "x-request-id": "req_abc-123.ok" })), "req_abc-123.ok");
  assert.notEqual(resolveRequestId(new Headers({ "x-request-id": "bad value!" })), "bad value!");
  assert.notEqual(resolveRequestId(new Headers({ "x-request-id": "x" })), "x");
  assert.match(resolveRequestId(new Headers()), /^[0-9a-f-]{36}$/);
});

test("formatAccessLogLine emits single-line log with hashed user id and no secrets", () => {
  const line = formatAccessLogLine({
    method: "POST",
    path: "/api/runtime/tasks",
    status: 400,
    durationMs: 12.4,
    requestId: "req-1234",
    userId: "user-alice",
  });
  assert.ok(!line.includes("\n"));
  assert.ok(line.includes("method=POST"));
  assert.ok(line.includes("path=/api/runtime/tasks"));
  assert.ok(line.includes("status=400"));
  assert.ok(line.includes("requestId=req-1234"));
  assert.ok(!line.includes("user-alice"));
  assert.ok(line.includes(`user=${hashUserId("user-alice")}`));
});

test("jsonErrorWithRequestId includes requestId in body and x-request-id header", async () => {
  const req = new NextRequest("http://localhost/api/runtime/tasks", {
    method: "POST",
    headers: { "x-request-id": "trace-9999" },
  });
  const res = jsonErrorWithRequestId(req, { error: "bad" }, { status: 400 });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get(REQUEST_ID_HEADER), "trace-9999");
  assert.deepEqual(await res.json(), { error: "bad", requestId: "trace-9999" });
});

test("POST /api/runtime/tasks error includes requestId in JSON and x-request-id header", async () => {
  const req = new NextRequest("http://localhost/api/runtime/tasks", {
    method: "POST",
    headers: { "x-request-id": "task-err-42" },
  });
  const res = await postTasks(req);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get(REQUEST_ID_HEADER), "task-err-42");
  const body = (await res.json()) as { error?: string; requestId?: string };
  assert.equal(body.requestId, "task-err-42");
});

test("POST /api/login and GET /api/providers errors include requestId and x-request-id", async () => {
  const loginReq = new NextRequest("http://localhost/api/login", {
    method: "POST",
    headers: { "x-request-id": "login-err-7", "content-type": "application/json" },
    body: JSON.stringify({ email: "", password: "" }),
  });
  const loginRes = await postLogin(loginReq);
  assert.ok(loginRes.status === 400 || loginRes.status === 401 || loginRes.status === 500);
  assert.equal(loginRes.headers.get(REQUEST_ID_HEADER), "login-err-7");
  assert.equal(((await loginRes.json()) as { requestId?: string }).requestId, "login-err-7");

  const prevMode = process.env.SWARM_SERVER_MODE;
  process.env.SWARM_SERVER_MODE = "1";
  try {
    const provReq = new NextRequest("http://localhost/api/providers", {
      method: "GET",
      headers: { "x-request-id": "prov-err-8" },
    });
    const provRes = await getProviders(provReq);
    assert.equal(provRes.status, 401);
    assert.equal(provRes.headers.get(REQUEST_ID_HEADER), "prov-err-8");
    assert.equal(((await provRes.json()) as { requestId?: string }).requestId, "prov-err-8");
  } finally {
    if (prevMode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = prevMode;
  }
});

test("middleware propagates x-request-id onto API responses", async () => {
  const prevMode = process.env.SWARM_SERVER_MODE;
  process.env.SWARM_SERVER_MODE = "0";
  try {
    const req = new NextRequest("http://localhost/api/health", {
      method: "GET",
      headers: { "x-request-id": "mw-req-100" },
    });
    const res = await middleware(req);
    assert.equal(res.headers.get(REQUEST_ID_HEADER), "mw-req-100");
  } finally {
    if (prevMode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = prevMode;
  }
});
