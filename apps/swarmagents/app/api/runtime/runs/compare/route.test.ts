import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import type { RunComparison } from "../../../../../lib/runtime/run-compare";
import { USER_HEADER } from "../../../../../lib/auth";
import { configureAuditPath, readAuditEntries } from "../../../../../lib/audit";
import { listMemories } from "../../../../../lib/memory/store";
import { configureProviderStorePaths } from "../../../../../lib/providers/store";
import { configureRunsDir, getRunsDir } from "../../../../../lib/telemetry/paths";

const ALICE = "local_alice@example.com";
const BOB = "local_bob@example.com";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-run-compare-"));
  configureRunsDir(join(tempDir, "runs"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  configureAuditPath(join(tempDir, "audit.jsonl"));
});

test.afterEach(() => {
  configureRunsDir(null);
  configureProviderStorePaths("");
  configureAuditPath(undefined);
  rmSync(tempDir, { recursive: true, force: true });
});

interface SeedRunOptions {
  runId: string;
  userId: string;
  withReport?: boolean;
  status?: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  providers?: string[];
  steps?: unknown[];
  artifacts?: Array<{ path: string; rel: string; size: number; mtimeMs: number; change: string }>;
  couldNotDo?: string[];
  shots?: unknown[];
}

function seedRun(opts: SeedRunOptions): void {
  const runsDir = getRunsDir();
  assert.ok(runsDir, "runsDir must be configured");
  mkdirSync(runsDir, { recursive: true });

  writeFileSync(
    join(runsDir, `${opts.runId}.jsonl`),
    `${JSON.stringify({
      seq: 1,
      runId: opts.runId,
      ts: 1_000,
      type: "run.created",
      data: { userId: opts.userId, prompt: `prompt for ${opts.runId}` },
    })}\n`,
    "utf-8",
  );

  if (opts.withReport === false) return;

  const reportDir = join(runsDir, "reports", opts.runId);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, "report.json"),
    JSON.stringify({
      runId: opts.runId,
      userId: opts.userId,
      status: opts.status ?? "finished",
      startedAt: 1_000,
      finishedAt: 1_000 + (opts.durationMs ?? 1_500),
      meta: {
        costUsd: opts.costUsd,
        durationMs: opts.durationMs,
        model: opts.model,
        providers: opts.providers ?? [],
      },
      steps: opts.steps ?? [],
      artifacts: opts.artifacts ?? [],
      couldNotDo: opts.couldNotDo ?? [],
      shots: opts.shots ?? [],
    }),
    "utf-8",
  );
}

function getReq(query: string, user: string | null = ALICE): NextRequest {
  const headers = new Headers();
  if (user) headers.set(USER_HEADER, user);
  return new NextRequest(`http://localhost/api/runtime/runs/compare${query}`, { headers });
}

function postReq(body: unknown, user: string | null = ALICE): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (user) headers.set(USER_HEADER, user);
  return new NextRequest("http://localhost/api/runtime/runs/compare", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("requires a signed-in caller", async () => {
  const res = await GET(getReq("?base=run_a&target=run_b", null));
  assert.equal(res.status, 401);
});

test("validates run ids and rejects self-comparison or path traversal", async () => {
  assert.equal((await GET(getReq("?base=run_a"))).status, 400);
  assert.equal((await GET(getReq("?base=../etc/passwd&target=run_b"))).status, 400);
  assert.equal((await GET(getReq("?base=run_same&target=run_same"))).status, 400);
});

test("conceals runs belonging to another account as 404", async () => {
  seedRun({ runId: "run_alice_1", userId: ALICE });
  seedRun({ runId: "run_bob_1", userId: BOB });

  const res = await GET(getReq("?base=run_alice_1&target=run_bob_1", ALICE));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("returns 409 when a run has not produced a report yet", async () => {
  seedRun({ runId: "run_done", userId: ALICE });
  seedRun({ runId: "run_active", userId: ALICE, withReport: false });

  const res = await GET(getReq("?base=run_done&target=run_active", ALICE));
  assert.equal(res.status, 409);
});

test("computes outcome, cost, duration, routing, artifact and blocker diffs accurately", async () => {
  seedRun({
    runId: "run_base",
    userId: ALICE,
    status: "error",
    costUsd: 0.04,
    durationMs: 4000,
    model: "claude-sonnet-4-5",
    providers: ["anthropic"],
    steps: [{ type: "tool.call" }, { type: "tool.result" }, { type: "assistant.text" }],
    artifacts: [
      { path: "/workspace/src/app.ts", rel: "src/app.ts", size: 1200, mtimeMs: 10, change: "modified" },
      { path: "/workspace/tmp.log", rel: "tmp.log", size: 300, mtimeMs: 10, change: "created" },
    ],
    couldNotDo: ["Docker daemon unavailable", "Missing API key"],
  });

  seedRun({
    runId: "run_target",
    userId: ALICE,
    status: "finished",
    costUsd: 0.01,
    durationMs: 2500,
    model: "gpt-4.1-mini",
    providers: ["openai"],
    steps: [{ type: "tool.call" }, { type: "tool.result" }],
    artifacts: [
      { path: "/workspace/src/app.ts", rel: "src/app.ts", size: 1450, mtimeMs: 20, change: "modified" },
      { path: "/workspace/src/app.test.ts", rel: "src/app.test.ts", size: 800, mtimeMs: 20, change: "created" },
    ],
    couldNotDo: ["Missing API key"],
  });

  const res = await GET(getReq("?base=run_base&target=run_target", ALICE));
  assert.equal(res.status, 200);
  const { comparison } = (await res.json()) as { comparison: RunComparison };

  assert.equal(comparison.outcome, "improved");
  assert.deepEqual(comparison.cost, {
    base: 0.04,
    target: 0.01,
    delta: -0.03,
    pctChange: -75,
    direction: "decreased",
  });
  assert.deepEqual(comparison.duration, {
    base: 4000,
    target: 2500,
    delta: -1500,
    pctChange: -37.5,
    direction: "decreased",
  });
  assert.equal(comparison.steps.delta, -1);

  assert.equal(comparison.routing.modelChanged, true);
  assert.deepEqual(comparison.routing.providersAdded, ["openai"]);
  assert.deepEqual(comparison.routing.providersRemoved, ["anthropic"]);

  assert.equal(comparison.artifacts.onlyInBase.length, 1);
  assert.equal(comparison.artifacts.onlyInBase[0].rel, "tmp.log");
  assert.equal(comparison.artifacts.onlyInTarget.length, 1);
  assert.equal(comparison.artifacts.onlyInTarget[0].rel, "src/app.test.ts");
  assert.equal(comparison.artifacts.inBoth.length, 1);
  assert.equal(comparison.artifacts.inBoth[0].sizeDeltaBytes, 250);

  assert.deepEqual(comparison.blockers.resolved, ["Docker daemon unavailable"]);
  assert.deepEqual(comparison.blockers.introduced, []);
  assert.deepEqual(comparison.blockers.persisting, ["Missing API key"]);
  assert.ok(comparison.highlights.length >= 4);
  assert.match(comparison.digest, /run_base -> run_target.*improved/);
});

test("POST with remember=true stores the comparison digest in the caller's memory and audits it", async () => {
  seedRun({
    runId: "run_mem_1",
    userId: ALICE,
    status: "finished",
    costUsd: 0.02,
    durationMs: 2000,
    model: "claude-sonnet-4-5",
    providers: ["anthropic"],
  });
  seedRun({
    runId: "run_mem_2",
    userId: ALICE,
    status: "finished",
    costUsd: 0.005,
    durationMs: 900,
    model: "gemini-2.5-flash",
    providers: ["gemini"],
  });

  const res = await POST(
    postReq(
      {
        baseRunId: "run_mem_1",
        targetRunId: "run_mem_2",
        remember: true,
        tags: ["benchmark", "Providers"],
      },
      ALICE,
    ),
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    comparison: RunComparison;
    remembered: { id: string; fact: string; tags: string[] };
  };
  assert.match(body.remembered.id, /^mem_/);
  assert.equal(body.remembered.fact, body.comparison.digest);
  assert.deepEqual(body.remembered.tags, ["run-comparison", "benchmark", "providers"]);

  // Stored strictly in Alice's account memory and never visible to Bob.
  assert.equal(listMemories(ALICE).length, 1);
  assert.equal(listMemories(BOB).length, 0);

  const entries = readAuditEntries(ALICE);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "run.compare.remember");
  assert.equal(entries[0].target, "run_mem_1..run_mem_2");
});
