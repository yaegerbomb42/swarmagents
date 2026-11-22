/**
 * Tests for classifyCostProvenance (lib/runtime/run-report-types.ts) —
 * the shared reported/estimated/mixed classification the report builder
 * records on ReportCardMeta and the report card renders. The card-side
 * string formatting is pinned in RunReportCard.token-usage.test.ts; this
 * file pins the classification itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyCostProvenance } from "./run-report-types";

test("classifies reported, estimated, and mixed from the counts", () => {
  // Every priced call provider-reported.
  assert.deepEqual(
    classifyCostProvenance({ costUsd: 0.042, calls: 2, unknownCostCalls: 0, reportedCostCalls: 2 }),
    { provenance: "reported", pricedCalls: 2, reportedCalls: 2 },
  );
  // No priced call provider-reported.
  assert.deepEqual(
    classifyCostProvenance({ costUsd: 0.011, calls: 2, unknownCostCalls: 0, reportedCostCalls: 0 }),
    { provenance: "estimated", pricedCalls: 2, reportedCalls: 0 },
  );
  // Some of each (priced = calls − unknown).
  assert.deepEqual(
    classifyCostProvenance({ costUsd: 0.05, calls: 4, unknownCostCalls: 1, reportedCostCalls: 2 }),
    { provenance: "mixed", pricedCalls: 3, reportedCalls: 2 },
  );
});

test("legacy accounting without reportedCostCalls reads as estimated", () => {
  // Every cost was an estimate before reported costs were captured.
  assert.deepEqual(
    classifyCostProvenance({ costUsd: 0.011, calls: 2, unknownCostCalls: 0, reportedCostCalls: undefined as unknown as number }),
    { provenance: "estimated", pricedCalls: 2, reportedCalls: 0 },
  );
});

test("inconsistent counts clamp instead of producing nonsense", () => {
  assert.deepEqual(
    classifyCostProvenance({ costUsd: 0.01, calls: 1, unknownCostCalls: 0, reportedCostCalls: 5 }),
    { provenance: "reported", pricedCalls: 1, reportedCalls: 1 },
  );
  assert.deepEqual(
    classifyCostProvenance({ costUsd: 0.01, calls: 2, unknownCostCalls: 0, reportedCostCalls: -3 }),
    { provenance: "estimated", pricedCalls: 2, reportedCalls: 0 },
  );
});

test("stays silent when there is no figure to classify", () => {
  // Cost unknown.
  assert.equal(classifyCostProvenance({ calls: 1, unknownCostCalls: 1, reportedCostCalls: 0 }), undefined);
  // $0 figures (free providers, reported zeros) stand alone, unlabeled.
  assert.equal(classifyCostProvenance({ costUsd: 0, calls: 3, unknownCostCalls: 0, reportedCostCalls: 0 }), undefined);
  assert.equal(classifyCostProvenance({ costUsd: 0, calls: 3, unknownCostCalls: 0, reportedCostCalls: 3 }), undefined);
  // A figure with no priced calls cannot be classified honestly.
  assert.equal(classifyCostProvenance({ costUsd: 0.01, calls: 1, unknownCostCalls: 1, reportedCostCalls: 0 }), undefined);
  // Junk numbers never produce a verdict.
  assert.equal(classifyCostProvenance({ costUsd: Number.NaN, calls: 1, unknownCostCalls: 0, reportedCostCalls: 1 }), undefined);
  assert.equal(classifyCostProvenance({ costUsd: -1, calls: 1, unknownCostCalls: 0, reportedCostCalls: 1 }), undefined);
});
