/**
 * Agent Studio API: auth, body caps, validation, version history, export
 * redaction and the deploy refusal.
 *
 * The runtime manager is replaced with a fake, so a successful deploy is
 * asserted without a VM.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { USER_HEADER } from "@/lib/auth";
import { AGENT_MANIFEST_VERSION, catalogModelIds } from "@/lib/agents/manifest";
import { configureAgentsDir } from "@/lib/agents/store";
import { setRuntimeManagerForTesting, type RuntimeManager } from "@/lib/runtime/manager";
import { GET as LIST, POST as CREATE } from "./route";
import { GET as ONE, PUT as REPLACE, DELETE as REMOVE } from "./[id]/route";
import { POST as CLONE } from "./[id]/clone/route";
import { GET as EXPORT } from "./[id]/export/route";
import { GET as HISTORY } from "./[id]/history/route";
import { POST as RESTORE } from "./[id]/restore/route";
import { GET as COMPAT } from "./[id]/compatibility/route";
import { POST as DEPLOY } from "./[id]/deploy/route";
import { GET as HARNESSES } from "./harnesses/route";
import { POST as IMPORT } from "./import/route";

const PREFERRED = [...catalogModelIds()][0];
let dir = "";

function req(method: string, url: string, body?: unknown, user: string | null = "alice"): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(user ? { [USER_HEADER]: user } : {}),
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: AGENT_MANIFEST_VERSION,
    id: "route-bot",
    name: "Route bot",
    description: "Handles routing.",
    identity: { systemPrompt: "You route requests." },
    models: { preferred: PREFERRED, fallbacks: [] },
    tools: ["Read", "Grep"],
    mcp: [],
    connectors: [],
    context: [],
    memory: { policy: "none" },
    skills: [],
    workflows: [],
    policies: {},
    permissions: { allowTools: [], denyTools: [], approvalRequired: false },
    subagents: [],
    ...overrides,
  };
}

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-agents-routes-"));
  configureAgentsDir(dir);
});

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
  configureAgentsDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every route refuses an unauthenticated caller", async () => {
  const calls: Array<Promise<Response>> = [
    LIST(req("GET", "/api/agents", undefined, null)),
    CREATE(req("POST", "/api/agents", manifest(), null)),
    ONE(req("GET", "/api/agents/route-bot", undefined, null), ctx("route-bot")),
    REPLACE(req("PUT", "/api/agents/route-bot", manifest(), null), ctx("route-bot")),
    REMOVE(req("DELETE", "/api/agents/route-bot", undefined, null), ctx("route-bot")),
    CLONE(req("POST", "/api/agents/route-bot/clone", {}, null), ctx("route-bot")),
    EXPORT(req("GET", "/api/agents/route-bot/export", undefined, null), ctx("route-bot")),
    HISTORY(req("GET", "/api/agents/route-bot/history", undefined, null), ctx("route-bot")),
    RESTORE(req("POST", "/api/agents/route-bot/restore", { versionIndex: 0 }, null), ctx("route-bot")),
    COMPAT(req("GET", "/api/agents/route-bot/compatibility", undefined, null), ctx("route-bot")),
    DEPLOY(req("POST", "/api/agents/route-bot/deploy", {}, null), ctx("route-bot")),
    HARNESSES(req("GET", "/api/agents/harnesses", undefined, null)),
    IMPORT(req("POST", "/api/agents/import", manifest(), null)),
  ];
  for (const res of await Promise.all(calls)) {
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});

test("create, read, list, replace and delete", async () => {
  const created = await CREATE(req("POST", "/api/agents", manifest()));
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { agent: { id: string; name: string } };
  assert.equal(createdBody.agent.id, "route-bot");

  const listed = await LIST(req("GET", "/api/agents"));
  const listBody = (await listed.json()) as { agents: Array<{ id: string }> };
  assert.deepEqual(listBody.agents.map((row) => row.id), ["route-bot"]);

  const one = await ONE(req("GET", "/api/agents/route-bot"), ctx("route-bot"));
  assert.equal(one.status, 200);

  const replaced = await REPLACE(req("PUT", "/api/agents/route-bot", manifest({ name: "Renamed" })), ctx("route-bot"));
  assert.equal(replaced.status, 200);
  const history = await HISTORY(req("GET", "/api/agents/route-bot/history"), ctx("route-bot"));
  const historyBody = (await history.json()) as { history: Array<{ versionIndex: number }> };
  assert.equal(historyBody.history.length, 1);

  const restored = await RESTORE(req("POST", "/api/agents/route-bot/restore", { versionIndex: 0 }), ctx("route-bot"));
  assert.equal(restored.status, 200);
  const restoredBody = (await restored.json()) as { agent: { name: string } };
  assert.equal(restoredBody.agent.name, "Route bot");

  const removed = await REMOVE(req("DELETE", "/api/agents/route-bot"), ctx("route-bot"));
  assert.equal(removed.status, 200);
  assert.equal((await ONE(req("GET", "/api/agents/route-bot"), ctx("route-bot"))).status, 404);
});

test("an invalid manifest is a 400 with the reasons", async () => {
  const res = await CREATE(req("POST", "/api/agents", manifest({ id: "Not A Slug" })));
  assert.equal(res.status, 400);
  const body = (await res.json()) as { errors: string[] };
  assert.ok(body.errors.some((error) => /id must be a slug/.test(error)));

  const tooBig = await CREATE(req("POST", "/api/agents", "x".repeat(70 * 1024)));
  assert.equal(tooBig.status, 413);
});

test("PUT refuses an id that does not match the path", async () => {
  assert.equal((await CREATE(req("POST", "/api/agents", manifest()))).status, 201);
  const res = await REPLACE(req("PUT", "/api/agents/route-bot", manifest({ id: "other-id" })), ctx("route-bot"));
  assert.equal(res.status, 400);
});

test("clone, export and import round-trip without leaking secrets", async () => {
  assert.equal((await CREATE(req("POST", "/api/agents", manifest()))).status, 201);

  const cloned = await CLONE(req("POST", "/api/agents/route-bot/clone", {}), ctx("route-bot"));
  assert.equal(cloned.status, 201);
  const cloneBody = (await cloned.json()) as { agent: { id: string; name: string } };
  assert.equal(cloneBody.agent.name, "Route bot (copy)");

  const exported = await EXPORT(req("GET", "/api/agents/route-bot/export"), ctx("route-bot"));
  assert.equal(exported.status, 200);
  const raw = await exported.text();
  assert.doesNotMatch(raw, /api[_-]?key|"token"|"secret"|"password"|authorization|credential/i);
  const pkg = JSON.parse(raw) as { format: string; formatVersion: number; agent: { id: string } };
  assert.equal(pkg.format, "swarm-agent");
  assert.equal(pkg.formatVersion, 1);
  assert.equal(pkg.agent.id, "route-bot");

  const imported = await IMPORT(req("POST", "/api/agents/import", pkg));
  assert.equal(imported.status, 201);
  const importedBody = (await imported.json()) as { agent: { id: string }; warnings: string[] };
  assert.equal(importedBody.agent.id, "route-bot-2", "an existing id is de-duped on import");
});

test("harnesses and compatibility report what this harness can run", async () => {
  assert.equal((await CREATE(req("POST", "/api/agents", manifest()))).status, 201);

  const harnesses = await HARNESSES(req("GET", "/api/agents/harnesses"));
  const harnessBody = (await harnesses.json()) as { harnesses: Array<{ id: string; capabilities: { tools: string[] } }> };
  assert.deepEqual(harnessBody.harnesses.map((row) => row.id), ["swarm"]);
  assert.ok(harnessBody.harnesses[0].capabilities.tools.includes("Bash"));

  const compat = await COMPAT(req("GET", "/api/agents/route-bot/compatibility"), ctx("route-bot"));
  const compatBody = (await compat.json()) as { report: { supported: string[]; missing: string[] } };
  assert.ok(compatBody.report.supported.some((entry) => /tool Read/.test(entry)));
  assert.deepEqual(compatBody.report.missing, []);
});

test("deploy refuses an incompatible agent and starts a run otherwise", async () => {
  // Incompatible: one tool the harness cannot grant.
  assert.equal((await CREATE(req("POST", "/api/agents", manifest({ tools: ["Read", "Teleport"] })))).status, 201);
  const refused = await DEPLOY(req("POST", "/api/agents/route-bot/deploy", {}), ctx("route-bot"));
  assert.equal(refused.status, 400);
  const refusedBody = (await refused.json()) as { missing: string[] };
  assert.ok(refusedBody.missing.some((entry) => /Teleport/.test(entry)));

  // Compatible: the fake runtime manager accepts the run.
  const calls: Array<Record<string, unknown>> = [];
  const fake = {
    start: (_userId: string, input: Record<string, unknown>) => {
      calls.push(input);
      return { accepted: true, runId: "run_agent_1", queued: false };
    },
  };
  setRuntimeManagerForTesting(fake as unknown as RuntimeManager);
  assert.equal(
    (await REPLACE(req("PUT", "/api/agents/route-bot", manifest({ tools: ["Read"] })), ctx("route-bot"))).status,
    200,
  );
  const deployed = await DEPLOY(req("POST", "/api/agents/route-bot/deploy", { harness: "swarm" }), ctx("route-bot"));
  assert.equal(deployed.status, 200);
  const deployedBody = (await deployed.json()) as { runId: string; harness: string };
  assert.equal(deployedBody.runId, "run_agent_1");
  assert.equal(deployedBody.harness, "swarm");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, PREFERRED);

  const unknown = await DEPLOY(req("POST", "/api/agents/route-bot/deploy", { harness: "nope" }), ctx("route-bot"));
  assert.equal(unknown.status, 400);
});
