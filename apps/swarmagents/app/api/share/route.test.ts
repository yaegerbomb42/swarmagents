/**
 * Integration tests for the token-gated guest live-room endpoints:
 * room state (GET /api/share/{token}), the read-only SSE stream
 * (GET /api/share/{token}/stream) and prompt suggestions
 * (POST /api/share/{token}/suggest).
 *
 * A real share token is created via the projects store; the owner runs a
 * prompt through the RuntimeManager (fake VM driver) so there is a live run
 * to spectate. Guests authenticate only with the token — no owner identity is
 * ever revealed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as roomGET } from "./[token]/route";
import { GET as streamGET } from "./[token]/stream/route";
import { POST as suggestPOST } from "./[token]/suggest/route";
import { createProject, createShareLink, configureProjectStoreDir } from "../../../lib/projects/store";
import { getSharedProject } from "../../../lib/projects/store";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../lib/runtime/manager";
import { VmManager } from "../../../lib/vm/manager";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import { configureRunsDir } from "../../../lib/telemetry/paths";
import { SuggestionsStore, setSuggestionsStoreForTesting, MAX_SUGGESTION_LEN } from "../../../lib/rooms/suggestions";
import { parseSse } from "../../../lib/client/sse";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ctx(token: string): { params: Promise<{ token: string }> } {
  return { params: Promise.resolve({ token }) };
}

function guestReq(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`);
}

function ownerReq(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { "x-swarm-user": "alice" },
  });
}

async function buildEnvironment(): Promise<{ token: string; ownerId: string; tmp: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-share-route-"));
  configureProjectStoreDir(path.join(tmp, "store"));
  configureRunsDir(path.join(tmp, "runs"));

  const owner = createProject("alice", { name: "Atlas" });
  const share = createShareLink("alice", owner.id);
  return { token: share.token, ownerId: "alice", tmp };
}

class ScriptedFakeVm extends FakeVmDriver {
  override async exec(): Promise<{ exitCode: number }> {
    // Keep the run "running" long enough for the endpoints to observe it live.
    await sleep(400);
    return { exitCode: 0 };
  }
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
  setSuggestionsStoreForTesting(null);
  configureRunsDir(null);
  configureProjectStoreDir("");
});

test("room state: invalid or unknown token is 404 and leaks no owner", async () => {
  const env = await buildEnvironment();
  try {
    const unknown = await roomGET(guestReq("/api/share/" + "0".repeat(48)), ctx("0".repeat(48)));
    assert.equal(unknown.status, 404);

    const malformed = await roomGET(guestReq("/api/share/not-a-token"), ctx("not-a-token"));
    assert.equal(malformed.status, 404);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test("room state: live=false when the owner has no active run", async () => {
  const env = await buildEnvironment();
  try {
    const res = await roomGET(guestReq(`/api/share/${env.token}`), ctx(env.token));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.live, false);
    assert.equal(body.run, null);
    assert.equal(body.projectId, getSharedProject(env.token)?.id);
    // The owner id must never leak to a guest.
    assert.equal(JSON.stringify(body).includes("alice"), false);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test("room state: live=true when the owner has a running run", async () => {
  const env = await buildEnvironment();
  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: new ScriptedFakeVm() }),
    router: null,
  });
  setRuntimeManagerForTesting(manager);
  try {
    const { runId, accepted } = manager.start(env.ownerId, { prompt: "do the thing" });
    assert.equal(accepted, true);
    const res = await roomGET(guestReq(`/api/share/${env.token}`), ctx(env.token));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.live, true);
    assert.equal(body.run.runId, runId);
    assert.equal(body.run.status, "running");
  } finally {
    manager.cancel(env.ownerId);
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test("stream: requires a live run and streams the owner's run read-only", async () => {
  const env = await buildEnvironment();
  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: new ScriptedFakeVm() }),
    router: null,
  });
  setRuntimeManagerForTesting(manager);
  try {
    // No run yet -> 404.
    const idle = await streamGET(guestReq(`/api/share/${env.token}/stream`), ctx(env.token));
    assert.equal(idle.status, 404);

    manager.start(env.ownerId, { prompt: "build the thing" });
    // Wait until the run is live in state.
    let live = false;
    for (let i = 0; i < 50 && !live; i++) {
      live = manager.list(env.ownerId).some((r) => r.status === "running");
      if (!live) await sleep(10);
    }
    assert.equal(live, true);

    const res = await streamGET(guestReq(`/api/share/${env.token}/stream`), ctx(env.token));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let done = false;
    for (let i = 0; i < 50 && !done; i++) {
      const result = await reader.read();
      done = result.done;
      if (result.value) text += decoder.decode(result.value, { stream: true });
      if (text.includes("event: run.created\n")) break;
    }
    await reader.cancel();
    assert.ok(text.includes("event: run.created\n"), "guest stream should include run.created");
  } finally {
    manager.cancel(env.ownerId);
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test("stream: invalid token is 404", async () => {
  const res = await streamGET(
    guestReq("/api/share/" + "0".repeat(48) + "/stream"),
    ctx("0".repeat(48)),
  );
  assert.equal(res.status, 404);
});

function suggestBody(token: string, prompt: string): NextRequest {
  return new NextRequest(`http://localhost/api/share/${token}/suggest`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
    headers: { "content-type": "application/json" },
  });
}

test("suggest: queue, validate and rate-limit guest input", async () => {
  const env = await buildEnvironment();
  const store = new SuggestionsStore({ now: () => 1000 });
  setSuggestionsStoreForTesting(store);
  try {
    // malformed token -> 404
    const bad = await suggestPOST(guestReq("/api/share/" + "0".repeat(48) + "/suggest"), ctx("0".repeat(48)));
    assert.equal(bad.status, 404);

    // valid token, empty prompt -> 400
    const empty = await suggestPOST(guestReq(`/api/share/${env.token}/suggest`), ctx(env.token));
    assert.equal(empty.status, 400);

    // too long -> 400
    const tooLong = await suggestPOST(suggestBody(env.token, "x".repeat(MAX_SUGGESTION_LEN + 1)), ctx(env.token));
    assert.equal(tooLong.status, 400);

    // success -> 201, suggestion queued FIFO
    const first = await suggestPOST(suggestBody(env.token, "run tests"), ctx(env.token));
    assert.equal(first.status, 201);
    const second = await suggestPOST(suggestBody(env.token, "deploy"), ctx(env.token));
    assert.equal(second.status, 201);

    const list = store.list(env.ownerId);
    assert.equal(list.length, 2);
    assert.equal(list[0].prompt, "run tests");
    assert.equal(list[1].prompt, "deploy");
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test("suggest: bounded by SWARM_MAX_QUEUED", async () => {
  const env = await buildEnvironment();
  const store = new SuggestionsStore({ now: () => 1000, maxQueued: 2 });
  setSuggestionsStoreForTesting(store);
  try {
    const post = async (prompt: string) => {
      const req = new NextRequest(`http://localhost/api/share/${env.token}/suggest`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
        headers: { "content-type": "application/json" },
      });
      return suggestPOST(req, ctx(env.token));
    };

    assert.equal((await post("one")).status, 201);
    assert.equal((await post("two")).status, 201);
    const third = await post("three");
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.equal(body.limit, 2);
    assert.equal(store.count(env.ownerId), 2);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test("suggest: rate-limited per owner window", async () => {
  const env = await buildEnvironment();
  let now = 1000;
  const store = new SuggestionsStore({ now: () => now, maxPerWindow: 2 });
  setSuggestionsStoreForTesting(store);
  try {
    const post = async (prompt: string) => {
      const req = new NextRequest(`http://localhost/api/share/${env.token}/suggest`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
        headers: { "content-type": "application/json" },
      });
      return suggestPOST(req, ctx(env.token));
    };

    assert.equal((await post("a")).status, 201);
    assert.equal((await post("b")).status, 201);
    const blocked = await post("c");
    assert.equal(blocked.status, 429);

    // After the window elapses, a new suggestion is allowed again.
    now += 61_000;
    assert.equal((await post("d")).status, 201);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
