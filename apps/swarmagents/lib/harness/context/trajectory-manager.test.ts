import assert from "node:assert/strict";
import test from "node:test";
import { TrajectoryOptimizer } from "./trajectory-manager";

test("TrajectoryOptimizer condenses verbose build logs, tracks token savings, and packs bounded L1 handoffs", () => {
  const opt = new TrajectoryOptimizer("Fix connector pagination and add unit tests", [
    "No hardcoded secrets",
    "Keep API backwards-compatible",
  ]);

  const noisyLog = [
    ...Array.from({ length: 120 }, (_, i) => `at async Promise.all (node:internal/process/task_queues:${i})`),
    "src/connectors/store.ts(42,10): error TS2345: Argument of type 'string' is not assignable.",
    ...Array.from({ length: 40 }, (_, i) => `info checking file ${i}...`),
  ].join("\n");

  const condensed = opt.condenseToolOutput(noisyLog, 1500);
  assert.equal(condensed.wasCondensed, true);
  assert.ok(condensed.tokensSaved > 100, `expected substantial savings, got ${condensed.tokensSaved}`);
  assert.match(condensed.text, /error TS2345/);

  opt.recordTurn({
    stepSummary: "Updated catalog projection in lib/connectors/catalog.ts",
    failedAttempt: {
      tried: "passed raw object",
      failedBecause: "TS2345 string mismatch",
      doNotRetry: "unvalidated field coercion",
    },
    errorOutput: noisyLog,
  });

  const packet = opt.buildContinuationPacket({
    files: [
      {
        path: "lib/connectors/store.ts",
        content: "export function connectConnector(userId: string): void {\n  return;\n}\n",
      },
    ],
    workingSet: [
      {
        path: "lib/connectors/store.ts",
        content: "export function connectConnector(userId: string): void {\n  return;\n}",
      },
    ],
  });

  assert.ok(packet.prompt.includes("Fix connector pagination"));
  assert.ok(packet.prompt.includes("error TS2345"));
  assert.ok(packet.usage.total <= 8192);
  assert.equal(opt.stats().turnsProcessed, 1);
});
