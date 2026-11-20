import test from "node:test";
import assert from "node:assert/strict";
import {
  SHADOW_VERIFIER_MAX_ROUNDS,
  SHADOW_VERIFIER_MIN_PASS_SCORE,
  bounceRemediationPrompt,
  buildShadowTarget,
  deriveBadge,
  inspectArtifactDiff,
  isShadowVerificationEnabled,
  runTestSuite,
  shadowVerifyRound,
  shouldBounce,
  synthesizeBuildFailure,
  type ShadowExec,
  type ShadowExecResult,
} from "./shadow-verifier.js";
import type { VerificationResult } from "../verification.js";

/** A scripted exec: returns stored results for exact commands, else a blank ok. */
function makeExec(script: Record<string, ShadowExecResult>): ShadowExec {
  return async (cmd) =>
    script[cmd.join(" ")] ?? { exitCode: 0, stdout: "", stderr: "" };
}

function passVerdict(score = 100): string {
  return JSON.stringify({ passed: true, score, violations: [] });
}

function failVerdict(score = 30, violations = ["Missing tests"]): string {
  return JSON.stringify({ passed: false, score, violations, remediationPrompt: `Fix: ${violations.join(", ")}` });
}

const ctx = {
  repoRoot: "/workspace/repo",
  testCommands: ["npm test", "npm run lint"],
  prompt: "Build the parser",
  round: 1,
};

test("runTestSuite passes when every command exits 0 and captures output", async () => {
  const exec = makeExec({
    "sh -c npm test": { exitCode: 0, stdout: "ok\n", stderr: "" },
    "sh -c npm run lint": { exitCode: 0, stdout: "lint clean\n", stderr: "" },
  });
  const result = await runTestSuite(exec, ctx.repoRoot, ctx.testCommands);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failedCommands, []);
  assert.match(result.output, /npm test/);
  assert.match(result.output, /ok/);
  assert.match(result.output, /npm run lint/);
});

test("runTestSuite fails and records the failing command", async () => {
  const exec = makeExec({
    "sh -c npm test": { exitCode: 1, stdout: "", stderr: "FAIL\n" },
    "sh -c npm run lint": { exitCode: 0, stdout: "lint clean\n", stderr: "" },
  });
  const result = await runTestSuite(exec, ctx.repoRoot, ctx.testCommands);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failedCommands, ["npm test"]);
  assert.match(result.output, /FAIL/);
});

test("shadowVerifyRound passes with green tests and a passing verifier", async () => {
  const exec = makeExec({
    "sh -c npm test": { exitCode: 0, stdout: "pass\n", stderr: "" },
    "sh -c npm run lint": { exitCode: 0, stdout: "lint\n", stderr: "" },
    "git diff --stat": { exitCode: 0, stdout: " src/x.ts | 2 +-\n", stderr: "" },
    "git status --porcelain": { exitCode: 0, stdout: " M src/x.ts\n", stderr: "" },
  });
  const summary = await shadowVerifyRound({ exec, callLLM: async () => passVerdict(97) }, ctx);
  assert.equal(summary.passed, true);
  assert.equal(summary.badge, "pass");
  assert.equal(summary.score, 97);
  assert.equal(summary.testsRan, true);
  assert.equal(summary.buildBroke, false);
});

test("shadowVerifyRound fails on a failing verifier and derives a warn badge", async () => {
  const summary = await shadowVerifyRound(
    { exec: makeExec({}), callLLM: async () => failVerdict(70, ["Over-budget API call"]) },
    ctx,
  );
  assert.equal(summary.passed, false);
  assert.equal(summary.badge, "warn");
  assert.match(summary.remediationPrompt ?? "", /Over-budget API call/);
});

test("shadowVerifyRound short-circuits on a broken build without calling the LLM", async () => {
  let llmCalled = false;
  const exec = makeExec({
    "sh -c npm test": { exitCode: 1, stdout: "", stderr: "build error\n" },
  });
  const summary = await shadowVerifyRound(
    { exec, callLLM: async () => { llmCalled = true; return passVerdict(); } },
    ctx,
  );
  assert.equal(llmCalled, false);
  assert.equal(summary.passed, false);
  assert.equal(summary.buildBroke, true);
  assert.equal(summary.badge, "fail");
  assert.match(summary.remediationPrompt ?? "", /npm test/);
});

test("inspectArtifactDiff tolerates a non-git repo", async () => {
  const exec = makeExec({
    "git diff --stat": { exitCode: 128, stdout: "", stderr: "fatal: not a git repo\n" },
  });
  const diff = await inspectArtifactDiff(exec, ctx.repoRoot);
  assert.ok(diff.length > 0);
  assert.match(diff, /no git diff available/);
});

test("inspectArtifactDiff includes changed paths on a git repo", async () => {
  const exec = makeExec({
    "git diff --stat": { exitCode: 0, stdout: " src/x.ts | 2 +-\n", stderr: "" },
    "git status --porcelain": { exitCode: 0, stdout: " M src/x.ts\n", stderr: "" },
  });
  const diff = await inspectArtifactDiff(exec, ctx.repoRoot);
  assert.match(diff, /src\/x\.ts/);
  assert.match(diff, /git status --porcelain/);
});

test("buildShadowTarget surfaces test output, diff, and constraints", () => {
  const target = buildShadowTarget(ctx, "PASS\n", " M src/x.ts");
  assert.equal(target.taskType, "code");
  assert.equal(target.phase, "semantic_acceptance");
  assert.match(target.output, /PASS\n/);
  assert.match(target.output, /src\/x\.ts/);
  assert.match(target.constraints![0], /exit 0/);
  assert.match(target.constraints![1], /artifact diff/);
});

test("deriveBadge maps pass/warn/fail", () => {
  assert.equal(deriveBadge({ passed: true, score: 40, violations: [] } as VerificationResult), "pass");
  assert.equal(deriveBadge({ passed: false, score: SHADOW_VERIFIER_MIN_PASS_SCORE, violations: ["x"] } as VerificationResult), "warn");
  assert.equal(deriveBadge({ passed: false, score: 10, violations: ["x"] } as VerificationResult), "fail");
});

test("shouldBounce bounds the remediation loop", () => {
  const failing = synthesizeBuildFailure({ ok: false, output: "", failedCommands: ["npm test"] });
  assert.equal(shouldBounce(failing, 1, 3), true);
  assert.equal(shouldBounce(failing, 2, 3), true);
  assert.equal(shouldBounce(failing, 3, 3), false);
  assert.equal(shouldBounce(failing, 99, 3), false);
  const passing = { passed: true, score: 100, violations: [], badge: "pass" as const, testsRan: true, buildBroke: false };
  assert.equal(shouldBounce(passing, 1, 3), false);
});

test("bounceRemediationPrompt carries the score and remediation", () => {
  const summary = synthesizeBuildFailure({ ok: false, output: "", failedCommands: ["npm test"] });
  const prompt = bounceRemediationPrompt(summary);
  assert.match(prompt, /Shadow verifier gate/);
  assert.match(prompt, /score 0\/100/);
  assert.match(prompt, /npm test/);
});

test("isShadowVerificationEnabled defaults on and honours explicit off", () => {
  assert.equal(isShadowVerificationEnabled({}), true);
  assert.equal(isShadowVerificationEnabled({ SWARM_SHADOW_VERIFIER: "1" }), true);
  assert.equal(isShadowVerificationEnabled({ SWARM_SHADOW_VERIFIER: "true" }), true);
  assert.equal(isShadowVerificationEnabled({ SWARM_SHADOW_VERIFIER: "0" }), false);
  assert.equal(isShadowVerificationEnabled({ SWARM_SHADOW_VERIFIER: "false" }), false);
});

test("SHADOW_VERIFIER_MAX_ROUNDS bounds the loop at a named constant", () => {
  assert.equal(SHADOW_VERIFIER_MAX_ROUNDS, 3);
});
