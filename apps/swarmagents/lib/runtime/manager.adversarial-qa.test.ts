import test from "node:test";
import assert from "node:assert/strict";
import { mergeQaSummary, shouldBounceOnQaFailure } from "./manager";
import type { ShadowVerificationSummary } from "../verification/shadow-verifier";
import type { AdversarialQaSummary } from "../verification/adversarial-qa";

const passed: ShadowVerificationSummary = {
  passed: true,
  score: 92,
  violations: [],
  badge: "pass",
  testsRan: true,
  buildBroke: false,
};

function qaSummary(overrides: Partial<AdversarialQaSummary> = {}): AdversarialQaSummary {
  return {
    passed: true,
    score: 95,
    violations: [],
    badge: "pass",
    testsRan: true,
    buildBroke: false,
    qaProvider: "deepseek",
    qaModel: "deepseek-chat",
    qaFamily: "deepseek",
    httpTraces: [{ label: "app", url: "https://swarmagents.codes", method: "GET", status: 200, ok: true, latencyMs: 42, bytes: 1234 }],
    screenshots: [],
    unverifiable: [],
    ...overrides,
  };
}

test("a QA failure bounces only within the shadow round cap", () => {
  assert.equal(shouldBounceOnQaFailure(true, 0), true);
  assert.equal(shouldBounceOnQaFailure(true, 1), true);
  // Attempts are 0-based: attempt 2 is the third and last round.
  assert.equal(shouldBounceOnQaFailure(true, 2), false);
  assert.equal(shouldBounceOnQaFailure(false, 0), false);
});

test("a QA failure is reflected as a failed run verification verdict", () => {
  const qaFailure = qaSummary({
    passed: false,
    score: 20,
    badge: "fail",
    violations: ["QA probe failed: health GET https://swarmagents.codes/api/health returned HTTP 500"],
    buildBroke: true,
  });
  assert.deepEqual(mergeQaSummary(passed, qaFailure), {
    ...passed,
    passed: false,
    score: 20,
    badge: "fail",
    violations: ["QA probe failed: health GET https://swarmagents.codes/api/health returned HTTP 500"],
    buildBroke: true,
  });
});

test("mergeQaSummary carries the QA remediation prompt on failure", () => {
  const remediation =
    "Adversarial QA (deepseek/deepseek-chat) blocked completion:\n- Home page shows a blank screen\n\nHTTP traces:\napp: GET https://swarmagents.codes -> HTTP 200 in 42ms";
  const qaFailure = qaSummary({
    passed: false,
    score: 20,
    badge: "fail",
    violations: ["Home page shows a blank screen"],
    remediationPrompt: remediation,
  });
  const merged = mergeQaSummary(passed, qaFailure);
  assert.equal(merged.remediationPrompt, remediation);
  assert.equal(merged.passed, false);
});

test("a passing QA never overrides the shadow summary's own remediation", () => {
  const shadowFailure: ShadowVerificationSummary = {
    ...passed,
    passed: false,
    score: 40,
    badge: "fail",
    violations: ["test failed"],
    remediationPrompt: "Fix the failing test.",
  };
  const merged = mergeQaSummary(shadowFailure, qaSummary());
  assert.equal(merged.passed, false);
  assert.equal(merged.remediationPrompt, "Fix the failing test.");
  assert.equal(merged.score, 40);
});
