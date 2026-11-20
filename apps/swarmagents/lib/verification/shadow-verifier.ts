/**
 * Shadow verifier gate.
 *
 * A cheap/free fast model acts as a continuous background auditor before a run
 * marks itself finished. The gate:
 *
 *   1. Runs the repository's test commands (from the codebase map) inside the
 *      run's workspace.
 *   2. Inspects the /workspace artifact diff.
 *   3. Sends the test output + diff through the semantic-acceptance phase of
 *      the universal verification pipeline (lib/verification.ts).
 *
 * If the code is unverified or the build broke, the run is bounced back to the
 * primary agent with a remediation prompt (bounded to a max number of rounds).
 *
 * This module is deliberately dependency-injected and pure: the manager wires
 * the exec driver and the cheap-model caller in, and unit tests inject fakes.
 */

import { verifyPhase, type LLMCaller, type VerificationResult } from "../verification";

/** Max primary-agent attempts (initial + bounces) before a run is accepted as-is. */
export const SHADOW_VERIFIER_MAX_ROUNDS = 3;
/** Score below which a failed verification shows a "fail" badge (else "warn"). */
export const SHADOW_VERIFIER_MIN_PASS_SCORE = 60;
/** Token cap for the cheap-model verifier call. */
export const SHADOW_VERIFIER_MAX_TOKENS = 1024;

export type ShadowBadge = "pass" | "warn" | "fail";

export interface ShadowExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Minimal exec adapter the gate uses (bound to the run's VM workspace). */
export interface ShadowExec {
  (cmd: string[], opts?: { cwd?: string; signal?: AbortSignal }): Promise<ShadowExecResult>;
}

export interface ShadowVerifierDeps {
  exec: ShadowExec;
  callLLM: LLMCaller;
}

export interface ShadowVerifierContext {
  /** Absolute repository root inside the workspace (the cwd for test runs). */
  repoRoot: string;
  /** The repository's test commands from the codebase map. */
  testCommands: string[];
  /** The task prompt the primary agent was working on. */
  prompt: string;
  /** 1-based verification round (for reporting). */
  round: number;
}

export interface TestSuiteExecution {
  ok: boolean;
  /** Combined stdout/stderr from every test command. */
  output: string;
  /** The commands that exited non-zero (empty when ok). */
  failedCommands: string[];
}

export interface ShadowVerificationSummary {
  passed: boolean;
  score: number;
  violations: string[];
  remediationPrompt?: string;
  badge: ShadowBadge;
  /** False when no tests could run (e.g. empty command list). */
  testsRan: boolean;
  /** True when a test command exited non-zero (build broke). */
  buildBroke: boolean;
}

/**
 * True when the shadow verifier gate is enabled. Off can be forced with
 * SWARM_SHADOW_VERIFIER=0.
 */
export function isShadowVerificationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.SWARM_SHADOW_VERIFIER?.trim();
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

/** Run one test command and capture its output. */
export async function runTestCommand(
  exec: ShadowExec,
  repoRoot: string,
  command: string,
): Promise<ShadowExecResult> {
  return exec(["sh", "-c", command], { cwd: repoRoot });
}

/**
 * Run every configured test command. Any non-zero exit fails the suite and is
 * recorded so the remediation prompt can name the culprit.
 */
export async function runTestSuite(
  exec: ShadowExec,
  repoRoot: string,
  testCommands: readonly string[],
): Promise<TestSuiteExecution> {
  const parts: string[] = [];
  const failedCommands: string[] = [];
  for (const command of testCommands) {
    const result = await runTestCommand(exec, repoRoot, command);
    parts.push(`$ ${command}\n${result.stdout}${result.stderr}`);
    if (result.exitCode !== 0) failedCommands.push(command);
  }
  return {
    ok: failedCommands.length === 0,
    output: parts.join("\n"),
    failedCommands,
  };
}

/**
 * Best-effort /workspace artifact diff summary. Never throws: a non-git repo
 * or a missing binary just yields a short note.
 */
export async function inspectArtifactDiff(
  exec: ShadowExec,
  repoRoot: string,
): Promise<string> {
  const lines: string[] = [];
  try {
    const stat = await exec(["git", "diff", "--stat"], { cwd: repoRoot });
    if (stat.exitCode === 0 && stat.stdout.trim()) {
      lines.push("$ git diff --stat", stat.stdout.trim());
    }
    const status = await exec(["git", "status", "--porcelain"], { cwd: repoRoot });
    if (status.exitCode === 0 && status.stdout.trim()) {
      lines.push("$ git status --porcelain", status.stdout.trim());
    }
  } catch {
    // Not a git checkout, or git is missing — the diff is just less informative.
  }
  return lines.length > 0 ? lines.join("\n") : "(no git diff available)";
}

/** Map a verification result to a badge. */
export function deriveBadge(result: VerificationResult): ShadowBadge {
  if (result.passed) return "pass";
  return result.score >= SHADOW_VERIFIER_MIN_PASS_SCORE ? "warn" : "fail";
}

/** Build the semantic-acceptance target the verifier audits. */
export function buildShadowTarget(
  ctx: ShadowVerifierContext,
  testOutput: string,
  diffSummary: string,
) {
  return {
    taskType: "code" as const,
    phase: "semantic_acceptance" as const,
    prompt: ctx.prompt,
    constraints: [
      "Every configured repository test command must pass (exit 0).",
      "The /workspace artifact diff must not contain broken, incomplete, or non-functional code.",
    ],
    output: `REPOSITORY TEST RESULTS:\n${testOutput}\n\nWORKSPACE ARTIFACT DIFF:\n${diffSummary}`,
  };
}

/** Remediation prompt for a broken build (skips the LLM entirely). */
export function synthesizeBuildRemediation(failedCommands: readonly string[]): string {
  return (
    "The repository's test suite failed (nonzero exit). Fix the failing commands so " +
    `they exit 0 and re-run the tests before finishing: ${failedCommands.join("; ")}.`
  );
}

/** Summary when the build broke — a hard fail, no LLM round-trip. */
export function synthesizeBuildFailure(tests: TestSuiteExecution): ShadowVerificationSummary {
  return {
    passed: false,
    score: 0,
    violations: [`Test suite failed: ${tests.failedCommands.join(", ")}`],
    remediationPrompt: synthesizeBuildRemediation(tests.failedCommands),
    badge: "fail",
    testsRan: true,
    buildBroke: true,
  };
}

/**
 * Run one verification round: execute the test suite, inspect the diff, and
 * (when the build held) send both through the verification pipeline.
 */
export async function shadowVerifyRound(
  deps: ShadowVerifierDeps,
  ctx: ShadowVerifierContext,
): Promise<ShadowVerificationSummary> {
  const tests = await runTestSuite(deps.exec, ctx.repoRoot, ctx.testCommands);
  if (!tests.ok) return synthesizeBuildFailure(tests);

  const diffSummary = await inspectArtifactDiff(deps.exec, ctx.repoRoot);
  const audit = await verifyPhase(buildShadowTarget(ctx, tests.output, diffSummary), deps.callLLM);

  return {
    passed: audit.passed,
    score: audit.score,
    violations: audit.violations,
    remediationPrompt: audit.remediationPrompt,
    badge: deriveBadge(audit),
    testsRan: true,
    buildBroke: false,
  };
}

/**
 * Bounce decision. `attemptsUsed` is the number of completed primary-agent
 * attempts (including this one). The gate bounces only while attempts remain
 * in the budget, so the run can never loop forever.
 */
export function shouldBounce(
  summary: ShadowVerificationSummary,
  attemptsUsed: number,
  maxRounds: number = SHADOW_VERIFIER_MAX_ROUNDS,
): boolean {
  return !summary.passed && attemptsUsed < maxRounds;
}

/** The prompt appended to the primary agent's next attempt after a bounce. */
export function bounceRemediationPrompt(summary: ShadowVerificationSummary): string {
  const base = summary.remediationPrompt ?? "Address the stated violations.";
  return `[Shadow verifier gate] Verification did not pass (score ${summary.score}/100). ${base}`;
}
