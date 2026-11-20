/**
 * Route tests for the browser control plane (`GET` frame + `POST`
 * navigate/screenshot) using a stub BrowserManager, so no Chromium is needed.
 * The URL policy is enforced by the manager (unit-tested separately); here we
 * verify the wire contract: auth, run-ownership gating, body validation, and
 * JPEG frame serving.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { GET as GET_FRAME } from "./frame/route";
import { setBrowserManagerForTesting, type BrowserControl, type BrowserFrame } from "../../../../../lib/browser/manager";
import { checkNavigation } from "../../../../../lib/browser/policy";
import { setRuntimeManagerForTesting, RuntimeManager } from "../../../../../lib/runtime/manager";
import { VmManager } from "../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../lib/vm/fake-driver";

const RUN = "run_test_browser";
const USER = "alice";
const JPEG = Buffer.from("fake-jpeg-bytes");

/** RuntimeManager that admits exactly {RUN} as alice's active/owned run. */
class GateRuntime extends RuntimeManager {
  constructor() {
    super({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });
  }
  override isActiveRun(userId: string, runId: string): boolean {
    return userId === USER && runId === RUN;
  }
  override ownsRun(userId: string, runId: string): boolean {
    return userId === USER && runId === RUN;
  }
}

function request(path: string, init: RequestInit = {}, user: string | null = USER): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${path}`, { ...init, headers, signal: init.signal ?? undefined });
}

function post(path: string, body: unknown, user: string | null = USER): Promise<Response> {
  return POST(request(path, { method: "POST", body: JSON.stringify(body) }, user), { params: Promise.resolve({ runId: RUN }) });
}

class StubBrowser implements BrowserControl {
  navigations: Array<{ runId: string; url: string }> = [];
  screenshots = 0;
  frame: BrowserFrame | null = null;

  async navigate(runId: string, url: string) {
    const check = checkNavigation(url);
    if (!check.ok) return { ok: false as const, reason: check.reason };
    this.navigations.push({ runId, url });
    return { ok: true as const, url: check.url, title: "Stub Page" };
  }
  async screenshot(runId: string) {
    this.screenshots += 1;
    return { ok: true as const, frameId: 1, width: 1280, height: 800 };
  }
  async act(runId: string, action: { kind: string }) {
    return { ok: true as const, url: "https://example.com/" };
  }
  async evaluate(runId: string, expression: string) {
    return { ok: true as const, value: null };
  }
  async getDiagnostics(runId: string) {
    return [];
  }
  async getFrame(runId: string): Promise<BrowserFrame | null> {
    return this.frame;
  }
  async close(runId: string): Promise<void> {}
}

let stub: StubBrowser;

test.beforeEach(() => {
  setRuntimeManagerForTesting(new GateRuntime());
  stub = new StubBrowser();
  setBrowserManagerForTesting(stub);
});

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
  setBrowserManagerForTesting(null);
});

test("rejects unauthenticated requests", async () => {
  assert.equal((await GET(request(`/api/runtime/browser/${RUN}`, {}, null), { params: Promise.resolve({ runId: RUN }) })).status, 401);
  assert.equal((await post("/api/runtime/browser", { url: "https://example.com/" }, null)).status, 401);
  assert.equal((await GET_FRAME(request(`/api/runtime/browser/${RUN}/frame`, {}, null), { params: Promise.resolve({ runId: RUN }) })).status, 401);
});

test("rejects invalid runId", async () => {
  const bad = { params: Promise.resolve({ runId: "bad run id!" }) };
  assert.equal((await GET(request("/api/runtime/browser/bad"), bad)).status, 400);
  assert.equal(
    (await POST(request("/api/runtime/browser", { method: "POST", body: JSON.stringify({ url: "https://example.com/" }) }), bad)).status,
    400,
  );
  assert.equal((await GET_FRAME(request("/api/runtime/browser/bad/frame"), bad)).status, 400);
});

test("rejects a run the user does not own / is not active", async () => {
  const other = request(`/api/runtime/browser/${RUN}`, {}, "bob");
  assert.equal((await GET(other, { params: Promise.resolve({ runId: RUN }) })).status, 404);
  assert.equal((await post("/api/runtime/browser", { url: "https://example.com/" }, "bob")).status, 404);
});

test("POST navigate: policy-blocked URLs never reach the browser", async () => {
  const res = await post("/api/runtime/browser", { url: "file:///etc/passwd" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Scheme "file"/);
  assert.equal(stub.navigations.length, 0);

  const privateRes = await post("/api/runtime/browser", { url: "http://127.0.0.1/" });
  assert.equal(privateRes.status, 400);
  assert.match((await privateRes.json()).error, /Private address/);
  assert.equal(stub.navigations.length, 0);
});

test("POST navigate: public URL returns ok with url/title", async () => {
  const res = await post("/api/runtime/browser", { url: "https://example.com/a" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, url: "https://example.com/a", title: "Stub Page" });
  assert.equal(stub.navigations.length, 1);
});

test("POST screenshot returns the frame id", async () => {
  const res = await post("/api/runtime/browser", { action: "screenshot" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, frameId: 1, width: 1280, height: 800 });
  assert.equal(stub.screenshots, 1);
});

test("POST rejects invalid bodies", async () => {
  assert.equal((await post("/api/runtime/browser", "not json")).status, 400);
  assert.equal((await post("/api/runtime/browser", [])).status, 400);
  assert.equal((await post("/api/runtime/browser", {})).status, 400);
  assert.equal((await post("/api/runtime/browser", { url: "" })).status, 400);
  assert.equal((await post("/api/runtime/browser", { url: "x".repeat(9000) })).status, 400);
});

test("GET frame returns the latest JPEG with no-store caching", async () => {
  assert.equal((await GET(request(`/api/runtime/browser/${RUN}`), { params: Promise.resolve({ runId: RUN }) })).status, 404);

  stub.frame = { frameId: 1, jpeg: JPEG, width: 1280, height: 800, capturedAt: Date.now() };
  const res = await GET(request(`/api/runtime/browser/${RUN}`), { params: Promise.resolve({ runId: RUN }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);

  const frameRes = await GET_FRAME(request(`/api/runtime/browser/${RUN}/frame`), { params: Promise.resolve({ runId: RUN }) });
  assert.equal(frameRes.status, 200);
  assert.deepEqual(Buffer.from(await frameRes.arrayBuffer()), JPEG);
});
