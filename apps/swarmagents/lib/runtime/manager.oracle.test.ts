import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isOraclePostRunEnabled, mergeOracleSummary } from "./manager";
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
