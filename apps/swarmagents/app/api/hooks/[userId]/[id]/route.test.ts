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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-route-"));
configureAmbientStore(dir);

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
  setAmbientEngineForTesting(engine());
  upsertRule(rule({}));
});

test.afterEach(() => {
  setAmbientEngineForTesting(null);
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
