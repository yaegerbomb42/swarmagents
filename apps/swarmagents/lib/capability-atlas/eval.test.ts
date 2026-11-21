import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRetrievalEval } from "./eval/run-eval";

describe("Retrieval evaluation (30 tasks)", () => {
  it("achieves >= 90% top-3 accuracy and < 250 average tokens per lookup", () => {
    const report = runRetrievalEval(3);
    assert.equal(report.total, 30);
    assert.ok(report.top3Accuracy >= 0.9);
    assert.ok(report.avgTokens < 250);
  });
});
