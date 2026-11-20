import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { TelemetryBus, type TelemetryEvent } from "../../../../lib/telemetry/bus";
import { configureRunsDir } from "../../../../lib/telemetry/paths";

function request(url: string, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${url}`, { headers });
}

function seed(dir: string): void {
  const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
  bus.publish("run_1", { type: "run.created", data: { prompt: "first run", userId: "alice" } });
  bus.publish("run_1", { type: "run.started", sessionId: "sess_1", model: "claude-sonnet" } as TelemetryEvent);
  bus.publish("run_1", { type: "usage", inputTokens: 400, outputTokens: 40, cachedTokens: 100 } as TelemetryEvent);
  bus.publish("run_1", { type: "usage", inputTokens: 100, outputTokens: 10 } as TelemetryEvent);
  bus.publish("run_1", { type: "run.finished", exitCode: 0, sessionId: "sess_1", costUsd: 0.03, durationMs: 2000, numTurns: 2 } as TelemetryEvent);
  bus.publish("run_2", { type: "run.created", data: { prompt: "bob run", userId: "bob" } });
  bus.publish("run_2", { type: "usage", inputTokens: 999, outputTokens: 99 } as TelemetryEvent);
}

test("GET /api/runtime/usage returns per-run and per-day totals for the caller", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-usage-route-"));
  configureRunsDir(dir);
  try {
    seed(dir);

    const res = await GET(request("/api/runtime/usage"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      days: Array<{ date: string; tokensIn: number; tokensOut: number; tokensCached: number; costUsd: number; runs: number; byModel: Record<string, { tokensIn: number }> }>;
      runs: Array<{ runId: string; tokensIn: number; tokensOut: number; costUsd?: number; model?: string }>;
      totals: { tokensIn: number; tokensOut: number; costUsd: number; runs: number };
    };
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].runId, "run_1");
    assert.equal(body.runs[0].tokensIn, 500);
    assert.equal(body.runs[0].tokensOut, 50);
    assert.equal(body.runs[0].costUsd, 0.03);
    assert.equal(body.runs[0].model, "claude-sonnet");
    assert.equal(body.days.length, 1);
    assert.equal(body.days[0].tokensIn, 500);
    assert.equal(body.days[0].tokensCached, 100);
    assert.equal(body.days[0].costUsd, 0.03);
    assert.equal(body.days[0].runs, 1);
    assert.equal(body.days[0].byModel["claude-sonnet"].tokensIn, 500);
    assert.equal(body.totals.tokensIn, 500);
    assert.equal(body.totals.runs, 1);

    // Another user's runs are not visible.
    const bob = (await (await GET(request("/api/runtime/usage", "bob"))).json()) as { totals: { tokensIn: number } };
    assert.equal(bob.totals.tokensIn, 999);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/usage requires sign-in", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-usage-route-"));
  configureRunsDir(dir);
  try {
    seed(dir);
    assert.equal((await GET(request("/api/runtime/usage", null))).status, 401);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
