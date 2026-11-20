/**
 * Tests for the server-side "Explain via Lens" strike helper.
 *
 * The message builder is pure (map + slice in, message out). The runner is
 * injectable, so the success / failure / timeout paths are tested without a
 * provider or a model — the real runLens path is exercised by the strike
 * route test's no-provider fallback case instead.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExplainLensMessage,
  runExplainLens,
  setStrikeLensRunnerForTesting,
} from "./strike-lens";
import { buildMapFromScan } from "./analyze";
import { buildDependencySlice } from "./slice";
import type { CodebaseMap, CodebaseScan } from "./types";

function map(): CodebaseMap {
  const scan: CodebaseScan = {
    repoRoot: "/workspace/demo",
    repoName: "demo",
    repoHash: "abcdef0123456789",
    generatedAt: new Date(0).toISOString(),
    files: [
      { path: "src/app.ts", bytes: 100, language: "TypeScript", exports: ["app"], imports: ["./core"] },
      { path: "src/core.ts", bytes: 50, language: "TypeScript", exports: ["core"] },
      { path: "src/unused.ts", bytes: 50, language: "TypeScript", exports: ["unused"] },
    ],
    churn: {},
  };
  return buildMapFromScan(scan, { repoRoot: "/workspace/demo" });
}

test.afterEach(() => {
  setStrikeLensRunnerForTesting(null);
});

test("buildExplainLensMessage lists the slice manifest and the in-slice import edges", () => {
  const m = map();
  const slice = buildDependencySlice(m, "src/app.ts");
  const message = buildExplainLensMessage(slice, m);
  assert.match(message, /Architecture of module src\/app\.ts/);
  assert.match(message, /src\/app\.ts/);
  assert.match(message, /src\/core\.ts/);
  assert.match(message, /src\/app\.ts imports src\/core\.ts/);
  // The unused file is outside the slice, so it never appears as an edge.
  assert.doesNotMatch(message, /unused/);
});

test("runExplainLens returns the findings when the lens runs", async () => {
  const m = map();
  const slice = buildDependencySlice(m, "src/app.ts");
  setStrikeLensRunnerForTesting(async (input) => {
    assert.equal(input.lens, "architecture");
    return {
      lens: "architecture",
      text: "```mermaid\nflowchart TD\nA-->B\n```",
      provider: "fake",
      model: "fake-model",
      costUsd: 0.001,
      latencyMs: 12,
      cached: true,
      createdAt: 7,
    };
  });
  const findings = await runExplainLens("alice", slice, m);
  assert.deepEqual(findings, {
    lens: "architecture",
    text: "```mermaid\nflowchart TD\nA-->B\n```",
    provider: "fake",
    model: "fake-model",
    costUsd: 0.001,
    cached: true,
  });
});

test("runExplainLens returns null when the lens throws", async () => {
  const m = map();
  const slice = buildDependencySlice(m, "src/app.ts");
  setStrikeLensRunnerForTesting(async () => {
    throw new Error("No LLM providers are configured with API keys.");
  });
  assert.equal(await runExplainLens("alice", slice, m), null);
});

test("runExplainLens returns null when the lens times out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = map();
  const slice = buildDependencySlice(m, "src/app.ts");
  setStrikeLensRunnerForTesting(() => new Promise(() => {}));
  const findings = runExplainLens("alice", slice, m, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  assert.equal(await findings, null);
});
