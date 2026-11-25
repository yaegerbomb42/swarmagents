import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isOraclePostRunEnabled, mergeOracleSummary, shouldBounceOnOracleRejection } from "./manager";
import type { ShadowVerificationSummary } from "../verification/shadow-verifier";
import { readRunVerification, writeRunVerification } from "../verification/store";

const passed: ShadowVerificationSummary = {
  passed: true,
  score: 92,
  violations: [],
  badge: "pass",
  testsRan: true,
  buildBroke: false,
};

test("post-run Oracle is off by default and requires an explicit opt-in", () => {
  assert.equal(isOraclePostRunEnabled({}), false);
  assert.equal(isOraclePostRunEnabled({ SWARM_ORACLE_POST_RUN: "0" }), false);
  assert.equal(isOraclePostRunEnabled({ SWARM_ORACLE_POST_RUN: "true" }), true);
  assert.equal(isOraclePostRunEnabled({ SWARM_ORACLE_POST_RUN: "1" }), true);
});

test("an Oracle rejection is reflected as a failed run verification verdict", () => {
  const oracleFailure: ShadowVerificationSummary = {
    passed: false,
    score: 0,
    violations: ["Oracle: tsc rejected the candidate"],
    badge: "fail",
    testsRan: true,
    buildBroke: true,
  };

  assert.deepEqual(mergeOracleSummary(passed, oracleFailure), {
    ...passed,
    passed: false,
    score: 0,
    badge: "fail",
    violations: ["Oracle: tsc rejected the candidate"],
    buildBroke: true,
  });
});

test("mergeOracleSummary carries the Oracle retry context as the remediation prompt on failure", () => {
  const retryContext =
    "The previous attempt was rejected by the oracle at \"tsc\" and its patch was discarded.\n" +
    "Diagnostic:\n" +
    "src/math.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
    "Definition of `mul` (src/math.ts:L1-3):\n1 | export function mul(a: number, b: number): number {";
  const oracleFailure: ShadowVerificationSummary = {
    passed: false,
    score: 0,
    violations: ["Oracle: src/math.ts(3,5): error TS2322"],
    badge: "fail",
    testsRan: true,
    buildBroke: true,
    remediationPrompt: retryContext,
  };

  const merged = mergeOracleSummary(passed, oracleFailure);
  assert.equal(merged.passed, false);
  assert.equal(merged.remediationPrompt, retryContext);
  assert.ok(merged.remediationPrompt?.includes("error TS2322"), "diagnostic survives");
  assert.ok(merged.remediationPrompt?.includes("Definition of `mul`"), "symbol definition survives");
  assert.ok(!merged.remediationPrompt?.includes("diff --git"), "no failed patch is fed back");
});

test("mergeOracleSummary keeps the shadow remediation prompt when the Oracle passes", () => {
  const shadow: ShadowVerificationSummary = { ...passed, remediationPrompt: "shadow remediation" };
  const merged = mergeOracleSummary(shadow, { ...passed, remediationPrompt: "oracle remediation" });
  assert.equal(merged.remediationPrompt, "shadow remediation");
  assert.equal(merged.passed, true);
});

test("shouldBounceOnOracleRejection bounces only on rejection within the round cap", () => {
  // SHADOW_VERIFIER_MAX_ROUNDS is 3: attempts 0 and 1 bounce, attempt 2 finalizes.
  assert.equal(shouldBounceOnOracleRejection(true, 0), true);
  assert.equal(shouldBounceOnOracleRejection(true, 1), true);
  assert.equal(shouldBounceOnOracleRejection(true, 2), false);
  assert.equal(shouldBounceOnOracleRejection(true, 3), false);
  // An Oracle error (not a rejection) never bounces, at any round.
  assert.equal(shouldBounceOnOracleRejection(false, 0), false);
  assert.equal(shouldBounceOnOracleRejection(false, 1), false);
});

test("the Oracle failure verdict persists with the run report verification metadata", () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-oracle-verdict-"));
  try {
    const merged = mergeOracleSummary(passed, {
      passed: false,
      score: 0,
      violations: ["Oracle: lint rejected the candidate"],
      badge: "fail",
      testsRan: true,
      buildBroke: false,
    });
    const verification = {
      badge: merged.badge,
      score: merged.score,
      roundsUsed: 1,
      violations: merged.violations,
      passed: merged.passed,
    };
    writeRunVerification("run_oracle", verification, runsDir);
    assert.deepEqual(readRunVerification("run_oracle", runsDir), verification);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
