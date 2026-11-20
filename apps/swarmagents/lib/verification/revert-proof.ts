/**
 * Stage 3 — Revert-Test Proof, adapted to SwarmAgents' VM workspace.
 *
 * Port of the standalone engine's `runStage3`
 * (packages/engine/src/autonomous/verification-pipeline.ts). Where the
 * standalone runs on a local checkout with `execa` + `node:fs`, this module
 * runs entirely through the shadow verifier's `ShadowExec` mechanism — the
 * same `sh -c` channel the manager already uses to run repo test commands
 * inside the run's VM workspace. No local filesystem access, no `execa`.
 *
 * The proof: back up the changed source files, revert them to HEAD (delete
 * added ones), re-run the repo's configured test commands — the changed
 * tests MUST fail on unpatched source — then restore the patch and confirm
 * the tests pass with it. A test that passes without the source patch is
 * tautological: it proves nothing about the change.
 *
 * Differences from the standalone, all deliberate:
 * - Test commands are the repo's configured commands from the codebase map
 *   (e.g. `npm test`), not `npx vitest run <testFiles>`: SwarmAgents
 *   cannot assume vitest. The proof is therefore suite-level, not
 *   per-file — a coarser signal, but the same pass/fail question.
 * - Backup/restore is `cp --parents` into a `mktemp -d` directory inside
 *   the VM plus `git checkout HEAD -- <file>` for the revert. Deleted
 *   source files are re-deleted on restore (the backup holds no copy of
 *   them, so an explicit `rm` is needed — the standalone's fs restore had
 *   the same gap for deletions and relied on the file simply not existing).
 * - Infrastructure failures (mktemp/git/cp failing) THROW instead of
 *   returning fail: the gate treats those as "skip verification" so a run
 *   is never blocked by gate plumbing, matching `runShadowGate`'s posture.
 *   Only proof outcomes (tautological tests, tests failing with the patch,
 *   test-only expectation rewrites) return `fail`.
 * - No timeout handling here: `ShadowExec` takes an optional AbortSignal
 *   but the shadow verifier's own test runs don't set one either. If a
 *   repo's suite can hang, that is a pre-existing gap in the gate family,
 *   not one this port introduces.
 */

import type { ShadowExec } from "./shadow-verifier";

export interface RevertProofSrcFile {
  file: string;
  status: "A" | "M" | "D";
}

export interface RevertProofInput {
  /** Absolute repository root inside the workspace (the cwd for test runs). */
  repoRoot: string;
  /** Changed non-test source files to revert (with their git status). */
  srcFiles: readonly RevertProofSrcFile[];
  /** Changed test files the proof must cover. */
  testFiles: readonly string[];
  /** The repository's test commands from the codebase map. */
  testCommands: readonly string[];
  /**
   * Rewritten-expectation counts per test file (from `findChangedAssertions`),
   * used only when there is no source file to revert against. A count > 0
   * means the diff rewrites existing expectations with no source change.
   */
  rewrittenExpectations?: ReadonlyMap<string, number> | undefined;
}

export type RevertProofResult =
  | { status: "pass"; details: string }
  | { status: "fail"; details: string; diagnostics: string[] }
  | { status: "skipped"; details: string };

/** Single-quote a shell argument (`'` → `'\''`). Paths come from git output, not the agent. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run one shell script inside the VM workspace; throw when the command itself errors. */
async function runScript(
  exec: ShadowExec,
  repoRoot: string,
  script: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return exec(["sh", "-c", script], { cwd: repoRoot });
}

/** Run every configured test command; true only when all exit 0. */
async function runTestCommands(
  exec: ShadowExec,
  repoRoot: string,
  testCommands: readonly string[],
): Promise<boolean> {
  for (const command of testCommands) {
    const result = await exec(["sh", "-c", command], { cwd: repoRoot });
    if (result.exitCode !== 0) return false;
  }
  return true;
}

export async function runRevertProof(
  exec: ShadowExec,
  input: RevertProofInput,
): Promise<RevertProofResult> {
  const { repoRoot, srcFiles, testFiles, testCommands } = input;
  if (testFiles.length === 0) {
    return { status: "skipped", details: "no new/modified tests to prove" };
  }
  if (testCommands.length === 0) {
    return { status: "skipped", details: "no test commands configured for this repo" };
  }

  if (srcFiles.length === 0) {
    // No src change to revert against — but that alone is not a pass: a
    // test-only diff that REWRITES existing expectations (the 2026-11-06
    // live case: toBe(5) → toBe(6), src untouched) has nothing to prove
    // and must fail here as well as in Stage 0. A test-only diff that
    // only ADDS tests (new files, or new assertions in an existing file)
    // still skips: there is nothing to revert-prove and nothing weakened.
    const rewritten: string[] = [];
    for (const file of testFiles) {
      const count = input.rewrittenExpectations?.get(file) ?? 0;
      if (count > 0) rewritten.push(`${file} (${count} changed expectation(s))`);
    }
    if (rewritten.length > 0) {
      return {
        status: "fail",
        details: "test-only diff rewrites existing expectations with no src change",
        diagnostics: [
          `revert-test proof FAILED: ${rewritten.join(", ")} change test expectations without any source change — there is no src patch to revert against, so the tests prove nothing; test expectations must not change unless the source under test changes too`,
        ],
      };
    }
    return { status: "skipped", details: "no src changes to revert against" };
  }

  // Back up current src files, then revert them to HEAD (delete added ones).
  const mktemp = await runScript(exec, repoRoot, "mktemp -d /tmp/swarm-revert-proof-XXXXXX");
  const backupDir = mktemp.stdout.trim();
  if (mktemp.exitCode !== 0 || !backupDir) {
    throw new Error("revert-test proof: could not create a backup directory in the VM");
  }

  const restore = async (): Promise<void> => {
    // Restore the patch from backup; re-delete files the patch deleted
    // (the backup holds no copy of them). Best-effort: never throw here.
    const lines: string[] = [`cp -a ${shQuote(backupDir)}/. .`];
    for (const { file, status } of srcFiles) {
      if (status === "D") lines.push(`rm -f ${shQuote(file)}`);
    }
    try {
      await runScript(exec, repoRoot, lines.join("\n"));
    } catch {
      // Restore is best-effort; a failure surfaces as a failing suite below.
    }
    try {
      await runScript(exec, repoRoot, `rm -rf ${shQuote(backupDir)}`);
    } catch {
      // Stale backup dir in /tmp is harmless.
    }
  };

  try {
    const backupLines: string[] = [];
    for (const { file } of srcFiles) {
      backupLines.push(
        `[ -f ${shQuote(file)} ] && cp --parents ${shQuote(file)} ${shQuote(backupDir)}`,
      );
    }
    const backup = await runScript(exec, repoRoot, backupLines.join("\n"));
    if (backup.exitCode !== 0) {
      throw new Error("revert-test proof: could not back up changed source files in the VM");
    }

    const revertLines: string[] = [];
    for (const { file, status } of srcFiles) {
      if (status === "A") revertLines.push(`rm -f ${shQuote(file)}`);
      else revertLines.push(`git checkout HEAD -- ${shQuote(file)}`);
    }
    const reverted = await runScript(exec, repoRoot, revertLines.join("\n"));
    if (reverted.exitCode !== 0) {
      throw new Error("revert-test proof: could not revert source files to HEAD in the VM");
    }

    const unpatchedPass = await runTestCommands(exec, repoRoot, testCommands);
    if (unpatchedPass) {
      return {
        status: "fail",
        details: "tests pass without the src patch",
        diagnostics: [
          `revert-test proof FAILED: new/modified tests pass on unpatched src — they are tautological (${testFiles.join(", ")})`,
        ],
      };
    }

    await restore();
    const patchedPass = await runTestCommands(exec, repoRoot, testCommands);
    if (!patchedPass) {
      return {
        status: "fail",
        details: "tests fail with patch applied",
        diagnostics: [
          `tests fail even with the src patch applied — the patch does not make its own tests pass`,
        ],
      };
    }
    return {
      status: "pass",
      details: `tests fail on unpatched src and pass with the patch (${testFiles.length} file(s))`,
    };
  } finally {
    // Never leave the worktree reverted, even when the proof itself errors.
    await restore();
  }
}
