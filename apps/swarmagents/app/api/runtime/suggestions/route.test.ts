/**
 * Tests for the owner-facing guest suggestion endpoints: listing pending
 * suggestions and running one (which moves it into the owner's real run
 * queue). Guests can never reach these routes — they require the owner's
 * session, and the suggestions are scoped to the owner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { POST } from "./[id]/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../lib/runtime/manager";
import { VmManager } from "../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../lib/vm/fake-driver";
import { configureRunsDir } from "../../../../lib/telemetry/paths";
import { SuggestionsStore, setSuggestionsStoreForTesting } from "../../../../lib/rooms/suggestions";
import { configureProjectStoreDir } from "../../../../lib/projects/store";

class ScriptedFakeVm extends FakeVmDriver {
  override async exec(): Promise<{ exitCode: number }> {
    // Keep a started run "running" so concurrent starts queue/refuse deterministically.
    await new Promise((r) => setTimeout(r, 400));
    return { exitCode: 0 };
  }
}

function req(pathname: string, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${pathname}`, { headers });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
  setSuggestionsStoreForTesting(null);
  configureRunsDir(null);
  configureProjectStoreDir("");
});

function managerWith(maxQueued = 3): RuntimeManager {
  return new RuntimeManager({
    vm: new VmManager({ customDriver: new ScriptedFakeVm() }),
    router: null,
    maxQueued,
  });
}

test("GET requires the owner's session", async () => {
  const res = await GET(req("/api/runtime/suggestions", null));
  assert.equal(res.status, 401);
});

test("GET lists only the owner's own pending suggestions", async () => {
  const store = new SuggestionsStore();
  setSuggestionsStoreForTesting(store);
  store.add("alice", "run from guest");
  store.add("bob", "bob's own");

  const res = await GET(req("/api/runtime/suggestions"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.suggestions.length, 1);
  assert.equal(body.suggestions[0].prompt, "run from guest");
});

test("POST runs a suggestion: consumes it and starts a run", async () => {
  const store = new SuggestionsStore();
  setSuggestionsStoreForTesting(store);
  const { suggestion } = store.add("alice", "ship it");
  assert.ok(suggestion);

  const manager = managerWith();
  setRuntimeManagerForTesting(manager);
  try {
    const res = await POST(req(`/api/runtime/suggestions/${suggestion!.id}`), ctx(suggestion!.id));
    assert.equal([201, 202].includes(res.status), true, `status ${res.status}`);
    const body = await res.json();
    assert.ok(body.runId);
    assert.equal(store.count("alice"), 0, "suggestion should be consumed");
    assert.ok(manager.list("alice").some((r) => r.runId === body.runId));
  } finally {
    manager.cancel("alice");
  }
});

test("POST unknown id is 404 and runs nothing", async () => {
  const store = new SuggestionsStore();
  setSuggestionsStoreForTesting(store);
  const manager = managerWith();
  setRuntimeManagerForTesting(manager);
  try {
    const res = await POST(req("/api/runtime/suggestions/nope"), ctx("nope"));
    assert.equal(res.status, 404);
    assert.equal(manager.list("alice").length, 0);
  } finally {
    manager.cancel("alice");
  }
});

test("POST leaves the suggestion pending when the run queue is full", async () => {
  const store = new SuggestionsStore();
  setSuggestionsStoreForTesting(store);
  // maxQueued 0 means only one run may exist at a time: once a run is
  // active, any further start is refused.
  const manager = managerWith(0);
  setRuntimeManagerForTesting(manager);
  try {
    manager.start("alice", { prompt: "first" });
    const { suggestion } = store.add("alice", "nice suggestion");
    assert.ok(suggestion);

    const res = await POST(req(`/api/runtime/suggestions/${suggestion!.id}`), ctx(suggestion!.id));
    assert.equal(res.status, 429);
    // The suggestion must remain pending, not lost.
    assert.ok(store.get("alice", suggestion!.id), "suggestion should remain pending");
  } finally {
    manager.cancel("alice");
  }
});
