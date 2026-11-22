import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { AmbientEngine } from "../../../../../lib/ambient/engine";
import { setAmbientEngineForTesting } from "../../../../../lib/ambient/runtime";
import { configureAmbientStore, upsertRule } from "../../../../../lib/ambient/store";
import type { AmbientRule } from "../../../../../lib/ambient/types";

let dir: string;

const SECRET = "hook-secret-0123456789abcdef";

function rule(partial: Partial<AmbientRule>): AmbientRule {
  return {
    id: "hook1",
    userId: "user_a",
    roleId: "main",
    prompt: "Investigate the trigger and write a short note.",
    toolAllowlist: ["Read", "Write"],
    enabled: true,
    kind: "webhook",
    webhookSecret: SECRET,
    ...partial,
  };
}

function engine(): AmbientEngine {
  return new AmbientEngine({
    ensureVm: async () => undefined,
    startRun: () => ({ accepted: true, runId: "run_hook_1", queued: false }),
  });
}

function request(
  body: unknown,
  headers: Record<string, string> = {},
  json = true,
): NextRequest {
  return new NextRequest("http://localhost/api/hooks/user_a/hook1", {
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-route-"));
  configureAmbientStore(dir);
  setAmbientEngineForTesting(engine());
  upsertRule(rule({}));
});

test.afterEach(() => {
  setAmbientEngineForTesting(null);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("an oversized webhook body is rejected with 413", async () => {
  const big = JSON.stringify({ blob: "a".repeat(300_000) });
  assert.ok(Buffer.byteLength(big, "utf8") > 256 * 1024);
  const res = await POST(request(big, { "x-swarm-hook-secret": SECRET }), context("user_a", "hook1"));
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /too large/i);
});

test("a malformed JSON body is rejected with 400", async () => {
  const res = await POST(request("{not json", { "x-swarm-hook-secret": SECRET }), context("user_a", "hook1"));
  assert.equal(res.status, 400);
});

test("an empty body is rejected with 400", async () => {
  const res = await POST(request("", { "x-swarm-hook-secret": SECRET }), context("user_a", "hook1"));
  assert.equal(res.status, 400);
});

test("a malformed userId is rejected with a structured 400 before dispatch", async () => {
  // userId with a space fails USER_RE — the engine would answer 401/404, not 400.
  const res = await POST(request({ ok: true }, { "x-swarm-hook-secret": SECRET }), context("user a", "hook1"));
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /invalid/i);
});

test("a malformed id is rejected with a structured 400 before dispatch", async () => {
  const res = await POST(request({ ok: true }, { "x-swarm-hook-secret": SECRET }), context("user_a", "bad id"));
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /invalid/i);
});

test("unknown rules and wrong secrets answer identically", async () => {
  const wrongSecret = await POST(
    request({}, { "x-swarm-hook-secret": "nope" }),
    context("user_a", "hook1"),
  );
  const unknownId = await POST(
    request({}, { "x-swarm-hook-secret": SECRET }),
    context("user_a", "hook_missing"),
  );
  const unknownUser = await POST(
    request({}, { "x-swarm-hook-secret": SECRET }),
    context("user_z", "hook1"),
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
    context("user_a", "hook1"),
  );
  assert.equal(res.status, 401);
});

test("a webhook with the wrong secret is rejected with 401", async () => {
  const res = await POST(request({ ok: true }, { "x-swarm-hook-secret": "nope" }), context("user_a", "hook1"));
  assert.equal(res.status, 401);
});

test("a webhook with the right secret fires a run", async () => {
  const res = await POST(request({ ok: true }, { "x-swarm-hook-secret": SECRET }), context("user_a", "hook1"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok?: boolean; runId?: string };
  assert.equal(body.ok, true);
  assert.equal(body.runId, "run_hook_1");
});

test("rate limit triggers 429 with no-store after too many attempts", async () => {
  // Use a distinct hook so other tests aren't affected
  upsertRule(rule({ id: "hook_rl" }));
  let lastRes;
  for (let i = 0; i < 305; i++) {
    lastRes = await POST(
      request({ ok: true }, { "x-swarm-hook-secret": "wrong", "x-real-ip": "198.51.100.42" }),
      context("user_a", "hook_rl"),
    );
    if (lastRes.status === 429) break;
  }
  assert.ok(lastRes);
  assert.equal(lastRes.status, 429);
  assert.equal(lastRes.headers.get("cache-control"), "no-store");
});

