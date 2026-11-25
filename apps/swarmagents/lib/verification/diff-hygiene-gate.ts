/**
 * Diff-hygiene gate — the exec-based half of the Stage 0 + Stage 3 port.
 *
 * `runDiffHygieneGate` is the additional gate the runtime manager runs in
 * its finalize path (see `runShadowGate` in lib/runtime/manager.ts), after
 * the shadow verifier round passes. It collects the /workspace diff through
 * the same `ShadowExec` channel, runs the pure Stage 0 checks
 * (`checkDiffHygiene`), then the Stage 3 revert-test proof
 * (`runRevertProof`), and returns a `ShadowVerificationSummary` — the same
 * outcome shape the shadow verifier uses, so the manager can bounce or
 * finalize with it unchanged.
 *
 * Ordering (deliberate): the gate runs AFTER the shadow round, only when
 * the suite is green. Stage 3's premise is a passing suite — running the
 * proof on a broken build is meaningless — and failing fast on a Stage 0
 * violation is not worth a second gate call site before the shadow round.
 * The cost is the test suite running twice more (reverted + restored) on
 * runs that change tests.
 *
 * The gate never throws for a proof outcome (those are `fail` summaries);
 * it throws only on infrastructure failure (git missing, exec error), and
 * the manager treats that as "skip verification" — a run is never blocked
 * or bounced by gate plumbing.
 */

import { analyzeSourceText } from "./ast-analysis";
import {
  checkDiffHygiene,
  findChangedAssertions,
  isTestFilePath,
  isTypeScriptSourcePath,
} from "./diff-hygiene";
import { runRevertProof, type RevertProofSrcFile } from "./revert-proof";
import type { ShadowExec, ShadowVerificationSummary } from "./shadow-verifier";

/** Cap on the collected unified diff; the secret scan is best-effort past it. */
export const MAX_COLLECTED_DIFF_CHARS = 200_000;

export interface WorktreeChangedFile {
  file: string;
  status: "A" | "M" | "D";
}

export interface WorktreeDiff {
  files: WorktreeChangedFile[];
  /** Unified diff of tracked files, plus synthetic diffs for new files. */
  diff: string;
  /** Current worktree content per file (test + TypeScript source files only). */
  contents: Map<string, string>;
  /** HEAD content per changed test file (absent when the file is new). */
  headContents: Map<string, string>;
}

export interface DiffHygieneGateDeps {
  exec: ShadowExec;
}

export interface DiffHygieneGateContext {
  /** Absolute repository root inside the workspace (the cwd for test runs). */
  repoRoot: string;
  /** The repository's test commands from the codebase map. */
  testCommands: string[];
}

export interface DiffHygieneGateOutcome {
  summary: ShadowVerificationSummary;
  /** True when the gate had nothing to check (no git diff / no changed files). */
  skipped: boolean;
  details: string;
}

function failSummary(violations: string[], details: string): ShadowVerificationSummary {
  return {
    passed: false,
    score: 0,
    violations,
    remediationPrompt:
      "Diff-hygiene / revert-test gate failed:\n" +
      violations.map((v) => `- ${v}`).join("\n"),
    badge: "fail",
    testsRan: true,
    buildBroke: false,
  };
}

function passSummary(details: string): ShadowVerificationSummary {
  return {
    passed: true,
    score: 100,
    violations: [],
    badge: "pass",
    testsRan: true,
    buildBroke: false,
  };
}

/** Parse `git diff HEAD --name-status` lines (`M\tpath`, `A\tpath`, `R100\told\tnew`). */
function parseNameStatus(output: string): WorktreeChangedFile[] {
  const files: WorktreeChangedFile[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = (parts[0] ?? "").charAt(0);
    const file = parts[parts.length - 1] ?? "";
    if (!file) continue;
    if (code === "A") files.push({ file, status: "A" });
    else if (code === "D") files.push({ file, status: "D" });
    else files.push({ file, status: "M" }); // M, R, C, T — treat as modified
  }
  return files;
}

/**
 * Collect the worktree diff through the VM exec channel. Returns null when
 * the repo is not a git checkout or git is unavailable (the gate then
 * skips). Never throws for missing content — a file that cannot be read is
 * simply absent from the maps and the checks that need it skip it.
 */
export async function collectWorktreeDiff(
  exec: ShadowExec,
  repoRoot: string,
): Promise<WorktreeDiff | null> {
  const nameStatus = await exec(["git", "diff", "HEAD", "--name-status"], { cwd: repoRoot });
  if (nameStatus.exitCode !== 0) return null;
  const files = parseNameStatus(nameStatus.stdout);
  const seen = new Set(files.map((f) => f.file));

  const untracked = await exec(["git", "ls-files", "--others", "--exclude-standard"], {
    cwd: repoRoot,
  });
  if (untracked.exitCode === 0) {
    for (const file of untracked.stdout.split("\n")) {
      const trimmed = file.trim();
      if (trimmed && !seen.has(trimmed)) {
        files.push({ file: trimmed, status: "A" });
        seen.add(trimmed);
      }
    }
  }

  let diff = "";
  const trackedDiff = await exec(["git", "diff", "HEAD"], { cwd: repoRoot });
  if (trackedDiff.exitCode === 0) diff = trackedDiff.stdout;

  // Current content for the files the pure checks read (test + TS source).
  const contents = new Map<string, string>();
  const readable = files.filter(
    (f) => isTestFilePath(f.file) || isTypeScriptSourcePath(f.file),
  );
  for (const { file } of readable) {
    const cat = await exec(["sh", "-c", `cat -- '${file.replace(/'/g, `'\\''`)}'`], {
      cwd: repoRoot,
    });
    if (cat.exitCode === 0) contents.set(file, cat.stdout);
  }

  // HEAD content for changed test files (the weakened-expectation check).
  const headContents = new Map<string, string>();
  for (const { file } of files.filter((f) => isTestFilePath(f.file))) {
    const show = await exec(["git", "show", `HEAD:${file}`], { cwd: repoRoot });
    if (show.exitCode === 0) headContents.set(file, show.stdout);
  }

  // Synthetic unified diffs for untracked files (all their lines are added),
  // so the secret scan covers new files too. Proper `@@ -0,0 +1,N @@`
  // hunks keep the reported line numbers exact.
  for (const { file, status } of files) {
    if (status !== "A") continue;
    const content = contents.get(file);
    if (content === undefined) continue; // non-test/non-TS new file: not scanned
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    diff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`;
    for (const line of lines) diff += `+${line}\n`;
  }
  if (diff.length > MAX_COLLECTED_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_COLLECTED_DIFF_CHARS)}\n[diff truncated at ${MAX_COLLECTED_DIFF_CHARS} chars — secret scan covers the prefix only]`;
  }

  return { files, diff, contents, headContents };
}

/**
 * Run Stage 0 (diff hygiene) then Stage 3 (revert-test proof) against the
 * run's workspace diff. A `skipped` outcome means there was nothing to
 * check (no git repo, or no changed files) — the caller finalizes as if
 * the gate passed.
 */
export async function runDiffHygieneGate(
  deps: DiffHygieneGateDeps,
  ctx: DiffHygieneGateContext,
): Promise<DiffHygieneGateOutcome> {
  const worktree = await collectWorktreeDiff(deps.exec, ctx.repoRoot);
  if (!worktree || worktree.files.length === 0) {
    return {
      summary: passSummary("no worktree diff to check"),
      skipped: true,
      details: "no worktree diff to check",
    };
  }

  const testFiles = worktree.files.filter((f) => isTestFilePath(f.file)).map((f) => f.file);
  const srcFiles: RevertProofSrcFile[] = worktree.files
    .filter((f) => !isTestFilePath(f.file))
    .map((f) => ({ file: f.file, status: f.status }));

  // Baseline assertion count from the HEAD versions of the changed test files.
  let baselineAssertionCount: number | undefined;
  if (testFiles.length > 0) {
    let baseline = 0;
    let sawHeadVersion = false;
    for (const file of testFiles) {
      const head = worktree.headContents.get(file);
      if (head !== undefined) {
        sawHeadVersion = true;
        baseline += analyzeSourceText(head, file).assertionCount;
      }
    }
    if (sawHeadVersion) baselineAssertionCount = baseline;
  }

  const hygiene = checkDiffHygiene({
    diff: worktree.diff,
    changedFiles: worktree.files.map((f) => f.file),
    changes: worktree.files.map((f) => ({ path: f.file, status: f.status })),
    baselineAssertionCount,
    readFile: (relPath) => worktree.contents.get(relPath),
    readHeadFile: (relPath) => worktree.headContents.get(relPath),
  });
  if (!hygiene.clean) {
    const details = `${hygiene.violations.length} diff-hygiene violation(s)`;
    return { summary: failSummary(hygiene.violations, details), skipped: false, details };
  }

  // Test-only expectation rewrites, for the Stage 3 no-src branch.
  const rewrittenExpectations = new Map<string, number>();
  if (srcFiles.length === 0) {
    for (const file of testFiles) {
      const head = worktree.headContents.get(file);
      const current = worktree.contents.get(file);
      if (head === undefined || current === undefined) continue;
      rewrittenExpectations.set(file, findChangedAssertions(head, current, file).length);
    }
  }

  const proof = await runRevertProof(deps.exec, {
    repoRoot: ctx.repoRoot,
    srcFiles,
    testFiles,
    testCommands: ctx.testCommands,
    rewrittenExpectations,
  });
  if (proof.status === "fail") {
    return { summary: failSummary(proof.diagnostics, proof.details), skipped: false, details: proof.details };
  }
  const details =
    proof.status === "pass"
      ? `diff hygiene clean; ${proof.details}`
      : `diff hygiene clean; revert-test proof ${proof.details}`;
  return { summary: passSummary(details), skipped: false, details };
}
