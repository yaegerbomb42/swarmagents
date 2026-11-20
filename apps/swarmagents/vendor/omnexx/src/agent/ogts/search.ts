/**
 * Step 7.4 — Oracle-Guided Tree Search: the beam search loop.
 *
 * Roadmap mapping: the brief's Step 7.4 is the simplified form of roadmap
 * Step 7.4 (Two-Strike Pruning Engine, `src/agent/search/pruning.ts`). This
 * file implements the brief's early-fail pruning instead — a branch dies on
 * its first `reject_repro` / `reject_fix` / `reject_regression` verdict (see
 * `isPruningVerdict` in `rollout.ts`). The roadmap's two-strike rules (kill
 * on 2 consecutive identical errors, cycle detection, diff oscillation, …)
 * are follow-ups, not in this PR.
 *
 * The loop is a greedy beam search: at each decision node it runs one rollout
 * step, then descends into the highest-scoring surviving candidate and repeats.
 * It terminates because depth is bounded (`MAX_DEPTH`), the node budget is
 * bounded (`MAX_NODES`), and a step with no survivors ends the search.
 *
 * The search is NOT wired into the agent loop or any CLI — this module is the
 * engine plus tests only. The production verifier below is the seam the loop
 * will use when it is wired up.
 */

import {
  runDifferentialMatrix,
  type DifferentialMatrixOptions,
  type DifferentialMatrixResult,
} from '../../verify/differential-tdr.js';
import type { CandidatePath, SearchNode, SearchTree } from './tree.js';
import { MAX_DEPTH, MAX_NODES } from './tree.js';
import { rolloutStep, type CandidateGenerator, type DifferentialVerifier } from './rollout.js';

/**
 * Context the real differential matrix needs. Unlike the brief's shorthand
 * ("run candidate patches through runDifferentialMatrix"), the real function
 * is `runDifferentialMatrix(repoRoot, baseSha, candidateDiff, reproTestPath,
 * options)` — it verifies a patch against a baseline commit in transient
 * worktrees, so the repo root, base commit, and repro test path are part of
 * the verifier's context, not per-candidate arguments.
 */
export interface VerifierContext {
  /** Repo root the transient verification worktrees are created from. */
  repoRoot: string;
  /** Base commit the candidate patch is diffed against. */
  baseSha: string;
  /** Repro test path, relative to the repo root. */
  reproTestPath: string;
  /** Passed through to `runDifferentialMatrix`. */
  options?: DifferentialMatrixOptions;
}

/**
 * The production verifier: each candidate patch is run through the real
 * Step 5.5 differential matrix bound to `context`.
 */
export function createDifferentialVerifier(context: VerifierContext): DifferentialVerifier {
  return {
    verify(candidateDiff: string): Promise<DifferentialMatrixResult> {
      return runDifferentialMatrix(
        context.repoRoot,
        context.baseSha,
        candidateDiff,
        context.reproTestPath,
        context.options ?? {},
      );
    },
  };
}

export interface BeamSearchDeps {
  generator: CandidateGenerator;
  verifier: DifferentialVerifier;
  /** Beam width K passed to each rollout step; defaults to `MAX_BRANCHING` (3). */
  beamWidth?: number;
}

export interface BeamSearchResult {
  /** Highest-value root-to-leaf path when the tree has any node, else `null`. */
  bestPath: CandidatePath | null;
  /** Number of candidate patches verified across all rollout steps. */
  nodesExplored: number;
  /** Number of candidates pruned by an early-fail verdict. */
  prunedCount: number;
}

/**
 * Beam search from the tree's root. At each step, run one rollout step at the
 * current node and descend into the highest-scoring surviving candidate.
 * Stops when the current node is at max depth, the tree is full, or a step
 * produces no surviving candidate. Returns the tree's best path plus counts.
 */
export async function beamSearch(
  tree: SearchTree,
  deps: BeamSearchDeps,
): Promise<BeamSearchResult> {
  let current: SearchNode = tree.root;
  let nodesExplored = 0;
  let prunedCount = 0;
  while (current.depth < MAX_DEPTH && tree.nodeCount < MAX_NODES) {
    const ranked = await rolloutStep(tree, current, {
      generator: deps.generator,
      verifier: deps.verifier,
      ...(deps.beamWidth !== undefined ? { beamWidth: deps.beamWidth } : {}),
    });
    const survivors = ranked.filter((candidate) => !candidate.pruned && candidate.node !== null);
    prunedCount += ranked.length - survivors.length;
    nodesExplored += ranked.length;
    if (survivors.length === 0) {
      break;
    }
    const best = survivors[0];
    const node = best?.node;
    if (node === undefined || node === null) {
      break;
    }
    tree.visit(current.id);
    current = node;
  }
  return { bestPath: tree.bestPath(), nodesExplored, prunedCount };
}
