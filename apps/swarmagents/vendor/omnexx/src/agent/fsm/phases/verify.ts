/**
 * Step 6.7: Phase D Parallel Verification & Import-Path Sentinel.
 *
 * Implements:
 *   - Parallel candidate evaluation across isolated worktrees
 *   - Import-Path Sentinel: detects host package escape (preventing false greens
 *     when tests mistakenly import host installed packages instead of worktree code)
 *   - Parsing and conversion to normalized CandidateEvaluation tuples
 */

import { realpathSync } from 'node:fs';
import { detectLiteralLeaks } from '../breakers.js';
import type { CandidatePatch, CandidateEvaluation } from '../types.js';

export function countDiffLines(diff: string): number {
  return diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---'),
    ).length;
}

export interface WorktreeImportCheck {
  packageName: string;
  resolvedFile: string;
}

export interface CandidateTestRunResult {
  candidateId: string;
  exitCode: number;
  reproPassed: boolean;
  newFailures: string[];
  extraCasesFailed?: number;
  importPathChecks?: WorktreeImportCheck[];
}

export interface ParallelVerificationOptions {
  repoRoot: string;
  problemStatement: string;
  reproCode?: string;
  runTestOnCandidate: (candidate: CandidatePatch) => Promise<CandidateTestRunResult>;
}

/**
 * Import-Path Sentinel:
 * Verifies that the imported package file resolves strictly inside the worktree root.
 * Returns false if resolved outside (e.g. host editable install escape).
 */
export function checkImportPathSentinel(
  worktreeRoot: string,
  resolvedPackageFile: string,
): boolean {
  try {
    const canonicalRoot = realpathSync.native(worktreeRoot);
    const canonicalFile = realpathSync.native(resolvedPackageFile);
    return canonicalFile.startsWith(canonicalRoot);
  } catch {
    // If file cannot be resolved, check lexically
    return resolvedPackageFile.startsWith(worktreeRoot);
  }
}

/**
 * Computes behavioral clustering: candidates touching identical files receive cluster bonuses.
 */
export function computeClusterSizes(candidates: CandidatePatch[]): Map<string, number> {
  const fileKeyMap = new Map<string, string[]>();
  for (const c of candidates) {
    const key = [...c.filesTouched].sort().join('|');
    const existing = fileKeyMap.get(key) ?? [];
    existing.push(c.id);
    fileKeyMap.set(key, existing);
  }

  const clusterSizeMap = new Map<string, number>();
  for (const ids of fileKeyMap.values()) {
    for (const id of ids) {
      clusterSizeMap.set(id, ids.length);
    }
  }

  return clusterSizeMap;
}

/**
 * Phase D Orchestrator: Executes verification across candidates in parallel.
 */
export async function runParallelVerification(
  candidates: CandidatePatch[],
  options: ParallelVerificationOptions,
): Promise<{ evaluations: CandidateEvaluation[]; envErrors: string[] }> {
  const clusterSizes = computeClusterSizes(candidates);
  const envErrors: string[] = [];

  const evalPromises = candidates.map(async (candidate, index): Promise<CandidateEvaluation> => {
    const testResult = await options.runTestOnCandidate(candidate);

    // Check Import-Path Sentinel
    if (testResult.importPathChecks) {
      for (const check of testResult.importPathChecks) {
        const isContained = checkImportPathSentinel(options.repoRoot, check.resolvedFile);
        if (!isContained) {
          envErrors.push(
            `ENV_ERROR: Candidate ${candidate.id} resolved ${check.packageName} to host path ${check.resolvedFile}`,
          );
        }
      }
    }

    // Detect literal leaks from problem statement or repro test code
    const leakCountFromProblem = detectLiteralLeaks(candidate.diff, options.problemStatement);
    const leakCountFromRepro = options.reproCode
      ? detectLiteralLeaks(candidate.diff, options.reproCode)
      : 0;
    const literalLeaksCount = leakCountFromProblem + leakCountFromRepro;

    const diffLines = countDiffLines(candidate.diff);
    const clusterSize = clusterSizes.get(candidate.id) ?? 1;

    return {
      candidateId: candidate.id,
      clean: candidate.syntaxValid && candidate.diagnosticsDelta <= 0 && testResult.exitCode === 0,
      newFailuresCount: testResult.newFailures.length,
      reproPassed: testResult.reproPassed,
      extraCasesFailed: testResult.extraCasesFailed ?? 0,
      literalLeaksCount,
      clusterSize,
      diffLines,
      filesTouched: candidate.filesTouched.length,
      index,
    };
  });

  const evaluations = await Promise.all(evalPromises);
  return { evaluations, envErrors };
}
