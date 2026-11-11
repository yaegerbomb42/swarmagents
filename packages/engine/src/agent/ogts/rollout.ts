/**
 * Step 7.3 — Oracle-Guided Tree Search: one beam rollout step.
 *
 * Roadmap mapping: the brief's Step 7.3 is the simplified form of roadmap
 * Step 7.3 (Adaptive Semantic Branching & Stage Temperature Schedule,
 * `src/agent/search/branching.ts` + `sampling.ts`). This file implements a
 * fixed-width beam step instead: K candidates per decision node, K bounded by
 * `MAX_BRANCHING`. The stage temperature schedule and per-stage branching
 * factors (LOCALIZE 3–5, PLAN 2–3, EDIT 4–8, …) are follow-ups, not in
 * this PR.
 *
 * One rollout step: ask the candidate generator for up to K patch diffs for a
 * node, verify each through the injected differential verifier, score the
 * survivors with `value.ts`, and add the survivors as children of the node.
 * Branches whose verdict fails early are pruned: they are never added to the
 * tree and are reported with `pruned: true` and `node: null`.
 *
 * All I/O sits behind the injected interfaces. The real candidate generator
 * is a model call and is out of scope here; the real verifier is
 * `createDifferentialVerifier` in `search.ts`, which calls the real
 * `runDifferentialMatrix`.
 */

import type {
  DifferentialMatrixResult,
  DifferentialVerdict,
} from '../../verify/differential-tdr.js';
import type { SearchNode, SearchTree } from './tree.js';
import { MAX_BRANCHING, MAX_DEPTH, MAX_NODES } from './tree.js';
import { oracleResultFromMatrix, scoreOracle } from './value.js';

/**
 * Produces candidate patch diffs (unified-diff strings) for a node. The real
 * implementation is a model call; tests inject a stub. `count` is the maximum
 * number of candidates wanted — implementations may return fewer.
 */
export interface CandidateGenerator {
  generate(node: SearchNode, count: number): Promise<string[]>;
}

/**
 * Runs one candidate patch through the differential matrix and returns the
 * raw matrix result. The production implementation is
 * `createDifferentialVerifier` in `search.ts`; tests inject a mock.
 */
export interface DifferentialVerifier {
  verify(candidateDiff: string): Promise<DifferentialMatrixResult>;
}

/** One candidate produced by a rollout step, ranked best-first. */
export interface RankedCandidate {
  /** The candidate patch diff. */
  patchDiff: string;
  /** Value score (0–1) from `value.ts`. */
  score: number;
  /** The differential-matrix verdict for this candidate. */
  verdict: DifferentialVerdict;
  /** True when the branch was pruned before being added to the tree. */
  pruned: boolean;
  /** The tree node for a surviving candidate; `null` when pruned. */
  node: SearchNode | null;
}

export interface RolloutDeps {
  generator: CandidateGenerator;
  verifier: DifferentialVerifier;
  /** Beam width K; defaults to `MAX_BRANCHING` (3). Capped at `MAX_BRANCHING`. */
  beamWidth?: number;
}

/**
 * Whether a verdict prunes its branch immediately. `reject_repro` (symptom
 * not reproduced) and `reject_fix` (repro still fails / patch did not apply)
 * are the brief's early-fail cases; `reject_regression` also prunes — a
 * candidate that introduces new failures is not a viable fix (roadmap 7.4
 * likewise rolls back immediately on a P2P regression). Only `pass` survives.
 */
export function isPruningVerdict(verdict: DifferentialVerdict): boolean {
  return (
    verdict.status === 'reject_repro' ||
    verdict.status === 'reject_fix' ||
    verdict.status === 'reject_regression'
  );
}

/**
 * Run one beam rollout step at `parent`: generate up to K candidates, verify
 * and score each, add the survivors as children of `parent` (each at
 * expansion cost 1 — one verification run), and return all candidates ranked
 * best-first (survivors by score descending, then pruned by score descending).
 *
 * Returns an empty array when `parent` cannot expand: it is already at
 * `MAX_DEPTH`, already has `MAX_BRANCHING` children, or the tree is full
 * (`MAX_NODES`). The generator is not called in that case.
 */
export async function rolloutStep(
  tree: SearchTree,
  parent: SearchNode,
  deps: RolloutDeps,
): Promise<RankedCandidate[]> {
  if (parent.depth >= MAX_DEPTH) {
    return [];
  }
  const beamWidth = Math.min(deps.beamWidth ?? MAX_BRANCHING, MAX_BRANCHING);
  const slots = Math.min(beamWidth - tree.childrenOf(parent.id).length, MAX_NODES - tree.nodeCount);
  if (slots <= 0) {
    return [];
  }
  const diffs = await deps.generator.generate(parent, slots);
  const ranked: RankedCandidate[] = [];
  for (const diff of diffs.slice(0, slots)) {
    const result = await deps.verifier.verify(diff);
    const score = scoreOracle(oracleResultFromMatrix(result), diff);
    if (isPruningVerdict(result.verdict)) {
      ranked.push({ patchDiff: diff, score, verdict: result.verdict, pruned: true, node: null });
      continue;
    }
    // Slots were reserved against the node budget, so this cannot return null
    // unless the tree changed under us; skip defensively if it does.
    const child = tree.addChild(parent.id, diff, 1);
    if (child === null) {
      continue;
    }
    tree.setScore(child.id, score);
    ranked.push({ patchDiff: diff, score, verdict: result.verdict, pruned: false, node: child });
  }
  ranked.sort((a, b) => {
    if (a.pruned !== b.pruned) {
      return a.pruned ? 1 : -1;
    }
    return b.score - a.score;
  });
  return ranked;
}
