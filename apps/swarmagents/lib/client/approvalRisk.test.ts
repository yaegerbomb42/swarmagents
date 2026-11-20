import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalRiskSegments } from "./approvalRisk";

test("risk-to-segments: allow maps to low / 1 segment", () => {
  assert.deepEqual(approvalRiskSegments("allow"), {
    tier: "low",
    segments: 1,
    label: "Low risk",
  });
});

test("risk-to-segments: ask maps to review / 2 segments", () => {
  assert.deepEqual(approvalRiskSegments("ask"), {
    tier: "review",
    segments: 2,
    label: "Review",
  });
});

test("risk-to-segments: deny maps to high / 3 segments", () => {
  assert.deepEqual(approvalRiskSegments("deny"), {
    tier: "high",
    segments: 3,
    label: "High risk",
  });
});
