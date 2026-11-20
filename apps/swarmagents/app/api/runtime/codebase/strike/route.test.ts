/**
 * Tests for POST /api/runtime/codebase/strike.
 *
 * The validation cases (unauthenticated, bad action, missing path, unknown
 * path, escaping path) never reach a VM. The success case runs against a
 * local checkout (`SWARM_CODEBASE_LOCAL_ROOT`) with a map seeded from the
 * same analyzer the VM runs, and a RuntimeManager backed by a FakeVmDriver
 * — no Docker, no live run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { buildMapFromScan } from "../../../../../lib/codebase/analyze";
import { createLocalScanner, scanRepoLocal } from "../../../../../lib/codebase/local-scanner";
import { setStrikeLensRunnerForTesting } from "../../../../../lib/codebase/strike-lens";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../../lib/runtime/manager";
import { VmManager, setVmManagerForTesting } from "../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../lib/vm/fake-driver";

let dir: string;
let home: string;
let repoRoot: string;
let manager: RuntimeManager;
let prevHome: string | undefined;
let prevLocalRoot: string | undefined;

function fixtureRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-strike-repo-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "core.ts"),
    "export function core() { return 1; }\n",
  );
  fs.writeFileSync(
    path.join(repo, "src", "app.ts"),
    'import { core } from "./core";\nexport const app = () => core();\n',
  );
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2),
  );
  return fs.realpathSync(repo);
}

function request(body: unknown, user: string | null = "alice"): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest("http://localhost/api/runtime/codebase/strike", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function post(body: unknown, user: string | null = "alice"): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await POST(request(body, user));
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-strike-test-"));
  home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  prevHome = process.env.HOME;
  process.env.HOME = home;
  repoRoot = fixtureRepo();
  prevLocalRoot = process.env.SWARM_CODEBASE_LOCAL_ROOT;
  process.env.SWARM_CODEBASE_LOCAL_ROOT = repoRoot;

  // Seed the map the route reads back, from a real analyzer scan.
  const scan = await scanRepoLocal(repoRoot);
  assert.ok(scan, "fixture scan must succeed");
  const map = buildMapFromScan(scan, { repoRoot });
  await createLocalScanner(home).publish("alice", repoRoot, map);

  const vm = new VmManager({ customDriver: new FakeVmDriver() });
  setVmManagerForTesting(vm);
  manager = new RuntimeManager({ vm });
  setRuntimeManagerForTesting(manager);
});

test.after(() => {
  setRuntimeManagerForTesting(null);
  setVmManagerForTesting(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevLocalRoot === undefined) delete process.env.SWARM_CODEBASE_LOCAL_ROOT;
  else process.env.SWARM_CODEBASE_LOCAL_ROOT = prevLocalRoot;
  fs.rmSync(dir, { recursive: true, force: true });
});

test.afterEach(() => {
  // Stop the background run the success case started.
  for (const run of manager.list("alice")) manager.cancel("alice", run.runId);
  setStrikeLensRunnerForTesting(null);
});

test("POST strike rejects a caller without x-swarm-user", async () => {
  const { status } = await post({ path: "src/app.ts", action: "refactor" }, null);
  assert.equal(status, 401);
});

test("POST strike rejects a missing or unknown action", async () => {
  const missing = await post({ path: "src/app.ts" });
  assert.equal(missing.status, 400);
  assert.match(String(missing.data.error), /action must be one of/);

  const unknown = await post({ path: "src/app.ts", action: "delete" });
  assert.equal(unknown.status, 400);
});

test("POST strike rejects a missing path", async () => {
  const { status, data } = await post({ action: "refactor" });
  assert.equal(status, 400);
  assert.match(String(data.error), /path is required/);
});

test("POST strike 404s a path that is not in the caller's map", async () => {
  const { status } = await post({ path: "src/nope.ts", action: "tests" });
  assert.equal(status, 404);
});

test("POST strike 404s a path that would escape the repo", async () => {
  const { status } = await post({ path: "../outside.ts", action: "explain" });
  assert.equal(status, 404);
});

test("POST strike starts a scoped run for a file in the map", async () => {
  const { status, data } = await post({ path: "src/app.ts", action: "refactor" });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  assert.equal(typeof data.runId, "string");
  assert.equal(data.queued, false);
  assert.ok(typeof data.sliceTokenEstimate === "number" && (data.sliceTokenEstimate as number) > 0);
  const runs = manager.list("alice");
  assert.ok(runs.some((run) => run.runId === data.runId), "the run is listed for the caller");
});

test("POST strike starts a scoped run for a top-level module", async () => {
  const { status, data } = await post({ path: "src", action: "explain" });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  assert.ok(typeof data.sliceTokenEstimate === "number" && (data.sliceTokenEstimate as number) > 0);
  // No provider is configured for the test user, so the server-side lens
  // fails and the strike falls back to the prompt-only wording.
  assert.equal(data.lens, undefined);
});

test("POST strike explain runs the architecture lens server-side and embeds its diagram", async () => {
  const diagram =
    "```mermaid\nflowchart TD\nA[src/app.ts] --> B[src/core.ts]\n```";
  setStrikeLensRunnerForTesting(async (input) => {
    assert.equal(input.lens, "architecture");
    assert.match(input.message, /src\/app\.ts/);
    assert.match(input.message, /imports/);
    return {
      lens: "architecture",
      text: diagram,
      provider: "fake",
      model: "fake-model",
      costUsd: 0,
      latencyMs: 5,
      cached: false,
      createdAt: 1,
    };
  });
  const { status, data } = await post({ path: "src/app.ts", action: "explain" });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  const lens = data.lens as Record<string, unknown>;
  assert.equal(lens.lens, "architecture");
  assert.equal(lens.text, diagram);
  assert.equal(lens.provider, "fake");
  const runs = manager.list("alice");
  const run = runs.find((item) => item.runId === data.runId);
  assert.ok(run, "the run is listed for the caller");
  assert.match(run!.prompt, /Architecture lens findings/);
  assert.ok(run!.prompt.includes(diagram), "the diagram rides in the run prompt");
  assert.doesNotMatch(run!.prompt, /Use the architecture lens on the slice/);
});

test("POST strike explain still starts the run when the lens throws", async () => {
  setStrikeLensRunnerForTesting(async () => {
    throw new Error("provider down");
  });
  const { status, data } = await post({ path: "src/app.ts", action: "explain" });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  assert.equal(data.lens, undefined);
  const runs = manager.list("alice");
  const run = runs.find((item) => item.runId === data.runId);
  assert.ok(run, "the run is listed for the caller");
  assert.match(run!.prompt, /Use the architecture lens on the slice/);
});

test("POST strike does not run the lens for refactor or tests", async () => {
  let calls = 0;
  setStrikeLensRunnerForTesting(async () => {
    calls += 1;
    throw new Error("must not be called");
  });
  const { status, data } = await post({ path: "src/app.ts", action: "refactor" });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  assert.equal(calls, 0);
  assert.equal(data.lens, undefined);
});
