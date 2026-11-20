import test from "node:test";
import assert from "node:assert/strict";
import { rankHeatmap, rankKeyFilesByFanIn } from "./ranking";
import { estimateTokens, truncateToTokenBudget } from "./tokens";
import { CONTEXT_PACK_TOKEN_BUDGET } from "./rules";
import { buildMapFromScan } from "./analyze";
import type { CodebaseScan } from "./types";

test("rankHeatmap orders by churn x size x fan-in x touches", () => {
  const ranked = rankHeatmap([
    { path: "a.ts", bytes: 100, fanIn: 1, churn90d: 10, agentTouches: 0 },
    { path: "hot.ts", bytes: 500, fanIn: 20, churn90d: 200, agentTouches: 5 },
    { path: "big.ts", bytes: 2000, fanIn: 0, churn90d: 0, agentTouches: 0 },
  ]);
  assert.equal(ranked[0].path, "hot.ts");
  assert.ok(ranked[0].heat > ranked[1].heat);
  assert.ok(ranked.every((r) => r.heat >= 0 && r.heat <= 1.000001));
});

test("rankHeatmap gives the touched file a higher heat", () => {
  const withoutTouch = rankHeatmap([
    { path: "a.ts", bytes: 1000, fanIn: 10, churn90d: 100, agentTouches: 0 },
    { path: "b.ts", bytes: 1000, fanIn: 10, churn90d: 100, agentTouches: 0 },
  ]);
  const withTouch = rankHeatmap([
    { path: "a.ts", bytes: 1000, fanIn: 10, churn90d: 100, agentTouches: 0 },
    { path: "b.ts", bytes: 1000, fanIn: 10, churn90d: 100, agentTouches: 7 },
  ]);
  assert.equal(withoutTouch[0].heat, withoutTouch[1].heat);
  assert.ok(withTouch[0].heat > withTouch[1].heat);
  assert.equal(withTouch[0].path, "b.ts");
});

test("rankHeatmap is stable and honours the limit", () => {
  const inputs = [
    { path: "b.ts", bytes: 10, fanIn: 1, churn90d: 1, agentTouches: 0 },
    { path: "a.ts", bytes: 10, fanIn: 1, churn90d: 1, agentTouches: 0 },
    { path: "c.ts", bytes: 10, fanIn: 1, churn90d: 1, agentTouches: 0 },
  ];
  const first = rankHeatmap(inputs, 2);
  const second = rankHeatmap(inputs, 2);
  assert.deepEqual(first.map((r) => r.path), ["a.ts", "b.ts"]);
  assert.deepEqual(first.map((r) => r.path), second.map((r) => r.path));
});

test("rankKeyFilesByFanIn prefers higher fan-in", () => {
  const ranked = rankKeyFilesByFanIn([
    { path: "b.ts", fanIn: 2 },
    { path: "a.ts", fanIn: 10 },
    { path: "c.ts", fanIn: 10 },
  ], 2);
  assert.deepEqual(ranked.map((r) => r.path), ["a.ts", "c.ts"]);
});

test("estimateTokens grows with the text and is zero for an empty string", () => {
  assert.equal(estimateTokens(""), 0);
  const small = estimateTokens("export function hello() { return 1; }");
  const large = estimateTokens("export function hello() { return 1; }".repeat(50));
  assert.ok(small > 0);
  assert.ok(large > small * 10);
});

test("truncateToTokenBudget enforces the budget", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i} some codebase context`).join("\n");
  const out = truncateToTokenBudget(text, 200);
  assert.ok(out.truncated);
  assert.ok(out.tokenEstimate <= 200, `estimate ${out.tokenEstimate} must fit the budget`);
  assert.match(out.text, /truncated to fit budget/);
});

test("truncateToTokenBudget leaves a text that already fits alone", () => {
  const text = "short pack";
  const out = truncateToTokenBudget(text, 1000);
  assert.equal(out.truncated, false);
  assert.equal(out.text, text);
});

test("the context pack never exceeds the token budget", () => {
  // A repository with far more files than the pack can describe.
  const files = Array.from({ length: 4000 }, (_, i) => ({
    path: `src/module-${i}/index.ts`,
    bytes: 2048,
    lines: 80,
    language: "TypeScript",
    exports: ["handler", "helper", "config"],
    imports: [`../module-${(i + 1) % 4000}/index`],
  }));
  const scan: CodebaseScan = {
    repoRoot: "/workspace/big",
    repoName: "big",
    repoHash: "hash",
    generatedAt: new Date(0).toISOString(),
    files,
    churn: Object.fromEntries(files.map((file) => [file.path, 500])),
  };
  const map = buildMapFromScan(scan, { repoRoot: scan.repoRoot, tokenBudget: CONTEXT_PACK_TOKEN_BUDGET });
  assert.ok(
    map.contextPack.tokenEstimate <= CONTEXT_PACK_TOKEN_BUDGET,
    `pack of ${map.contextPack.tokenEstimate} tokens must stay under ${CONTEXT_PACK_TOKEN_BUDGET}`,
  );
  assert.ok(map.contextPack.text.length > 0);
});
