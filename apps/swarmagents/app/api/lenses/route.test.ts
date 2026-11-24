import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { lensErrorResponse } from "../../../lib/lenses/error-response";
import { RouterError } from "../../../lib/providers/router";
import { configureProviderStorePaths, saveProvider } from "../../../lib/providers/store";
import { configureRunsDir, getRunsDir } from "../../../lib/telemetry/paths";
import { telemetryBus } from "../../../lib/telemetry";
import { VmManager, setVmManagerForTesting } from "../../../lib/vm/manager";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import type { VmFileBytes, VmHandle } from "../../../lib/vm/types";

const USER = "lens-user@example.com";
const apiKey = "sk-test-openai-lens-route";

let tempDir: string;
const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-lens-route-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  configureRunsDir(join(tempDir, "runs"));
  // FIX-04: host SWARM_KEYS_* never serve account ids — seed a per-user key.
  delete process.env.SWARM_KEYS_OPENAI;
  delete process.env.SWARM_KEYS_ANTHROPIC;
  delete process.env.SWARM_KEYS_GEMINI;
  saveProvider(USER, { id: "openai", apiKey });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  setVmManagerForTesting(null);
  configureRunsDir(null);
  rmSync(tempDir, { recursive: true, force: true });
});

function openaiOk(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
    model: "gpt-4.1-mini",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function post(body: unknown, user: string | null = USER): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/lenses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(user ? { "x-swarm-user": user } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

test("requires a signed-in caller", async () => {
  globalThis.fetch = (async () => jsonResponse(openaiOk("x"))) as unknown as typeof globalThis.fetch;
  const res = await post({ lens: "eli5", message: "hello" }, null);
  assert.equal(res.status, 401);
});

test("rejects an unknown lens", async () => {
  const res = await post({ lens: "interpret-dreams", message: "hello" });
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /lens/i);
});

test("rejects a missing or oversized message", async () => {
  const missing = await post({ lens: "eli5" });
  assert.equal(missing.status, 400);
  const huge = await post({ lens: "eli5", message: "x".repeat(20_001) });
  assert.equal(huge.status, 400);
});

test("rejects an invalid run id", async () => {
  const res = await post({ lens: "eli5", message: "hello", runId: "../etc/passwd" });
  assert.equal(res.status, 400);
});

test("another user's run is invisible", async () => {
  const runsDir = getRunsDir();
  assert.ok(runsDir, "a runs dir is required for this test");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(
    join(runsDir, "lens_other_run.jsonl"),
    `${JSON.stringify({
      seq: 1,
      runId: "lens_other_run",
      ts: 1,
      type: "run.created",
      data: { userId: "someone-else@example.com", prompt: "hi" },
    })}\n`,
    "utf-8",
  );
  globalThis.fetch = (async () => jsonResponse(openaiOk("x"))) as unknown as typeof globalThis.fetch;
  const res = await post({ lens: "eli5", message: "hello", runId: "lens_other_run" });
  assert.equal(res.status, 404);
});

test("answers a lens, on the cheapest model, and caches it per message and lens", async () => {
  const bodies: string[] = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ""));
    return jsonResponse(openaiOk("A very simple explanation."));
  }) as unknown as typeof globalThis.fetch;

  const res = await post({ lens: "eli5", message: "The router now fails over in 200ms." });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.text, "A very simple explanation.");
  assert.equal(json.provider, "openai");
  assert.equal(json.model, "gpt-4.1-mini");
  assert.equal(json.cached, false);
  assert.equal(typeof json.costUsd, "number");
  assert.equal(json.costUsd > 0, true);
  assert.equal(JSON.stringify(json).includes(apiKey), false, "the key must never reach the client");
  assert.match(bodies[0], /5-year-old/);

  // The same message and lens again: served from the cache, no new call.
  const again = await post({ lens: "eli5", message: "The router now fails over in 200ms." });
  const againJson = await again.json();
  assert.equal(againJson.cached, true);
  assert.equal(againJson.text, "A very simple explanation.");
  assert.equal(bodies.length, 1, "the cached answer must not cost a second provider call");
});

test("a failing provider answers with a redacted error, never with key material", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({ error: { message: `bad credential ${apiKey}` } }, 401)) as unknown as typeof globalThis.fetch;
  const res = await post({ lens: "security", message: "hello there" });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(String(body.error).includes(apiKey), false);
});

test("lensErrorResponse surfaces RouterError messages only", async () => {
  const res = lensErrorResponse(new RouterError("No providers configured.", "no_providers"));
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "No providers configured.");
});

test("lensErrorResponse hides internals for any non-RouterError", async () => {
  // A raw leaked internal message (e.g. a stack path or key material) must
  // never reach the client.
  const res = lensErrorResponse(new Error(`secret ${apiKey} at /srv/app/lib/foo.ts:12`));
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Lens failed.");
  assert.equal(String(body.error).includes(apiKey), false);
  assert.equal(String(body.error).includes("/srv/app"), false);

  // Non-Error throws are generic too.
  const thrown = lensErrorResponse("something unexpected");
  assert.equal(thrown.status, 502);
  assert.equal(((await thrown.json()) as { error: string }).error, "Lens failed.");
});

test("a run artifact that is a symlink outside /workspace never reaches the provider", async () => {
  const runsDir = getRunsDir();
  assert.ok(runsDir, "a runs dir is required for this test");
  mkdirSync(runsDir, { recursive: true });
  const runId = "lens_secret_run";
  writeFileSync(
    join(runsDir, `${runId}.jsonl`),
    `${JSON.stringify({
      seq: 1,
      runId,
      ts: 1,
      type: "run.created",
      data: { userId: USER, prompt: "summarize the run" },
    })}\n`,
    "utf-8",
  );
  const reportDir = join(runsDir, "reports", runId);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, "report.json"),
    JSON.stringify({
      runId,
      userId: USER,
      artifacts: [
        { path: "/workspace/notes.txt", rel: "notes.txt", size: 21, mtimeMs: 0, change: "created" },
        {
          path: "/workspace/link/secret.txt",
          rel: "link/secret.txt",
          size: 32,
          mtimeMs: 0,
          change: "created",
        },
      ],
    }),
    "utf-8",
  );

  const driver = new FakeVmDriver();
  setVmManagerForTesting(new VmManager({ customDriver: driver }));
  const handle = await driver.ensure(USER);
  await driver.writeFile(handle, "/workspace/notes.txt", "BENIGN_CONTEXT_MARKER");
  await driver.writeFile(handle, "/etc/secret.txt", "HOST_SECRET_MARKER_MUST_NOT_LEAK");
  driver.symlink(USER, "/workspace/link", "/etc");

  const bodies: string[] = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ""));
    return jsonResponse(openaiOk("Summary."));
  }) as unknown as typeof globalThis.fetch;

  const res = await post({ lens: "eli5", message: "summarize the run", runId });
  assert.equal(res.status, 200);
  assert.equal(bodies.length, 1);
  // The in-workspace artifact is still useful context...
  assert.equal(bodies[0].includes("BENIGN_CONTEXT_MARKER"), true);
  // ...but the symlinked host file is refused and never sent.
  assert.equal(bodies[0].includes("HOST_SECRET_MARKER_MUST_NOT_LEAK"), false);
});

test("lens calls are rate limited per user, cached answers are not", async () => {
  globalThis.fetch = (async () => jsonResponse(openaiOk("ok"))) as unknown as typeof globalThis.fetch;
  let limited = 0;
  let served = 0;
  for (let index = 0; index < 30; index += 1) {
    const res = await post({ lens: "eli5", message: `a different message ${index}` });
    if (res.status === 429) limited += 1;
    else served += 1;
  }
  assert.ok(limited > 0, "the lens rate limit must kick in");
  assert.ok(served > 0, "some requests are served before the limit");

  // A cached answer is free: it never touches the rate limit.
  const cached = await post({ lens: "eli5", message: "a different message 0" });
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).cached, true);
});

test("a rate-limited caller cannot trigger VM artifact reads", async () => {
  // Count actual VM disk reads so we can prove the exhausted caller is refused
  // before any filesystem access.
  class CountingDriver extends FakeVmDriver {
    reads = 0;
    override async readFileBytes(
      handle: VmHandle,
      path: string,
      maxBytes: number,
    ): Promise<VmFileBytes> {
      this.reads += 1;
      return super.readFileBytes(handle, path, maxBytes);
    }
  }

  const runsDir = getRunsDir();
  assert.ok(runsDir, "a runs dir is required for this test");
  mkdirSync(runsDir, { recursive: true });
  const runId = "lens_rate_run";
  writeFileSync(
    join(runsDir, `${runId}.jsonl`),
    `${JSON.stringify({
      seq: 1,
      runId,
      ts: 1,
      type: "run.created",
      data: { userId: USER, prompt: "summarize the run" },
    })}\n`,
    "utf-8",
  );
  const reportDir = join(runsDir, "reports", runId);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, "report.json"),
    JSON.stringify({
      runId,
      userId: USER,
      artifacts: [
        { path: "/workspace/notes.txt", rel: "notes.txt", size: 21, mtimeMs: 0, change: "created" },
      ],
    }),
    "utf-8",
  );

  const driver = new CountingDriver();
  setVmManagerForTesting(new VmManager({ customDriver: driver }));
  const handle = await driver.ensure(USER);
  await driver.writeFile(handle, "/workspace/notes.txt", "BENIGN_DISK_MARKER");

  globalThis.fetch = (async () => jsonResponse(openaiOk("ok"))) as unknown as typeof globalThis.fetch;

  // Exhaust the per-user lens budget with plain (no-run) requests.
  let limited = 0;
  for (let index = 0; index < 80 && limited === 0; index += 1) {
    const res = await post({ lens: "eli5", message: `drain ${index}` });
    if (res.status === 429) limited += 1;
  }
  assert.ok(limited > 0, "the lens budget must be exhausted");

  // A run-backed request is now refused BEFORE it can read any VM artifact.
  const readsBefore = driver.reads;
  const probe = await post({ lens: "eli5", message: "summarize the run differently", runId });
  assert.equal(probe.status, 429);
  assert.equal(driver.reads, readsBefore, "a rate-limited caller must not trigger VM artifact reads");
});

/** A second caller so these tests never share USER's rate-limit bucket. */
const USER2 = "lens-user-2@example.com";

test("an aborted lens request returns 499, not a provider error", async () => {
  saveProvider(USER2, { id: "openai", apiKey });
  globalThis.fetch = (async () => jsonResponse(openaiOk("x"))) as unknown as typeof globalThis.fetch;
  const ctrl = new AbortController();
  ctrl.abort();
  const res = await POST(
    new NextRequest("http://localhost/api/lenses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-user": USER2 },
      body: JSON.stringify({ lens: "eli5", message: "hello" }),
      signal: ctrl.signal,
    }),
  );
  assert.equal(res.status, 499);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Request aborted.");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("an unexpected failure inside runLens answers 500 without leaking internals", async (t) => {
  saveProvider(USER2, { id: "openai", apiKey });
  // Seed a run owned by USER2 so the lens runs with a runId and attributes
  // its cost through the telemetry bus.
  const runsDir = getRunsDir();
  assert.ok(runsDir, "a runs dir is required for this test");
  mkdirSync(runsDir, { recursive: true });
  const runId = "lens_telemetry_run";
  writeFileSync(
    join(runsDir, `${runId}.jsonl`),
    `${JSON.stringify({
      seq: 1,
      runId,
      ts: 1,
      type: "run.created",
      data: { userId: USER2, prompt: "hello telemetry" },
    })}\n`,
    "utf-8",
  );
  globalThis.fetch = (async () => jsonResponse(openaiOk("Telemetry boom."))) as unknown as typeof globalThis.fetch;
  const boom = new Error("telemetry write failed at /tmp/internal/secret-path/run.log");
  t.mock.method(telemetryBus, "publish", () => {
    throw boom;
  });
  const res = await post({ lens: "eli5", message: "hello telemetry", runId }, USER2);
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Lens failed.");
  assert.equal(JSON.stringify(body).includes("/tmp/internal/secret-path"), false);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("rejects an oversized body with 413", async () => {
  const res = await POST(
    new NextRequest("http://localhost/api/lenses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-user": USER },
      body: JSON.stringify({ lens: "eli5", message: "hello", pad: "x".repeat(300 * 1024) }),
    }),
  );
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "Request body too large." });
});
