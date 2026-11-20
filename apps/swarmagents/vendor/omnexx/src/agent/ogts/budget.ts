/**
 * Step 7.7 — Oracle-Guided Tree Search: the adaptive budget tier governor.
 *
 * Roadmap mapping: this file matches roadmap Step 7.7 (Adaptive Budget Tier
 * Governor, `src/agent/search/budget.ts`) in content and in filename — only
 * the directory differs (`src/agent/ogts/` instead of `src/agent/search/`,
 * per the brief).
 *
 * Tiers (from the roadmap/brief):
 *
 *   Tier S: 1 candidate, 1 node — estimated pass@1 > 0.65.
 *   Tier M: 4–8 candidates, 10–20 nodes — 0.35 < pass@1 < 0.65.
 *   Tier L: 16–32 candidates, 30–60 nodes — pass@1 < 0.35 AND high task value.
 *
 * Boundary semantics (the brief leaves the exact boundaries open; these are
 * the decisions, pinned by tests):
 *
 *   - pass@1 exactly 0.65 → M (S requires strictly greater than 0.65).
 *   - pass@1 exactly 0.35 → M (L requires strictly less than 0.35).
 *   - pass@1 < 0.35 with LOW task value → M (L requires high task value).
 *   - So the M band is pass@1 in [0.35, 0.65], plus low-value tasks below 0.35.
 *
 * Verifier noise guard: when verifier precision measured on pilot data is
 * below 0.70 (`NOISE_GUARD_PRECISION`), the budget locks to Tier S whatever
 * pass@1 and task value say, to prevent noise amplification. The guard only
 * applies when a precision was actually measured — when no pilot precision
 * is supplied, `governBudget` classifies on pass@1 / task value alone.
 * Inputs are clamped to 0–1 (a pass@1 or precision outside 0–1 is a caller
 * error in the data, not a reason to throw from the governor).
 *
 * Mapping a tier to search bounds (`tierSearchBounds`): the tier spec's
 * candidate range is a per-search ceiling, so the desired beam width is
 * `min(candidates.max, MAX_BRANCHING)`; the desired node budget is the
 * tier's node range max. Both are then clamped to the engine's current caps
 * (`MAX_NODES` = 12, `MAX_BRANCHING` = 3) for `effective`. The result carries
 * both, so the caller can see what the tier asked for and what the engine
 * can actually grant.
 *
 * Tier L (and the top of Tier M) exceeds the engine's current `MAX_NODES` =
 * 12 today: M wants up to 20 nodes, L wants 30–60. Those tiers are
 * aspirational until the tree bounds in `tree.ts` are raised — this file
 * does NOT raise them, and `effective.maxNodes` stays at 12.
 *
 * Naming: `enforceBudget` already exists in `src/agent/budget-guard.ts`
 * (turn/message budget enforcement) with a different meaning, so nothing
 * here is called `enforceBudget`. The governor API is `classifyTier`,
 * `governBudget`, `specForTier`, and `tierSearchBounds`.
 *
 * This module is NOT wired into the agent loop, the beam search, or any
 * CLI — engine plus tests only.
 */

import { MAX_BRANCHING, MAX_NODES } from './tree.js';

/** Budget tier names. */
export type BudgetTierName = 'S' | 'M' | 'L';

/** Task value, as judged by the caller (e.g. from the task's impact/urgency). */
export type TaskValue = 'low' | 'high';

/** An inclusive range, e.g. Tier M's 4–8 candidates. */
export interface TierRange {
  min: number;
  max: number;
}

/** One tier's candidate and node budgets. */
export interface BudgetTierSpec {
  tier: BudgetTierName;
  candidates: TierRange;
  nodes: TierRange;
}

/** Tier S: 1 candidate, 1 node. */
export const TIER_S_SPEC: BudgetTierSpec = {
  tier: 'S',
  candidates: { min: 1, max: 1 },
  nodes: { min: 1, max: 1 },
};

/** Tier M: 4–8 candidates, 10–20 nodes. */
export const TIER_M_SPEC: BudgetTierSpec = {
  tier: 'M',
  candidates: { min: 4, max: 8 },
  nodes: { min: 10, max: 20 },
};

/** Tier L: 16–32 candidates, 30–60 nodes. */
export const TIER_L_SPEC: BudgetTierSpec = {
  tier: 'L',
  candidates: { min: 16, max: 32 },
  nodes: { min: 30, max: 60 },
};

/** All tier specs, S → M → L. */
export const BUDGET_TIERS: readonly BudgetTierSpec[] = [TIER_S_SPEC, TIER_M_SPEC, TIER_L_SPEC];

/** pass@1 above this → Tier S (strictly greater; exactly this value is M). */
export const TIER_S_PASS_AT_1 = 0.65;
/** pass@1 below this (with high task value) → Tier L (exactly this value is M). */
export const TIER_L_PASS_AT_1 = 0.35;
/** Verifier precision below this on pilot data locks the budget to Tier S. */
export const NOISE_GUARD_PRECISION = 0.7;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The spec for one tier name. */
export function specForTier(tier: BudgetTierName): BudgetTierSpec {
  switch (tier) {
    case 'S':
      return TIER_S_SPEC;
    case 'M':
      return TIER_M_SPEC;
    case 'L':
      return TIER_L_SPEC;
  }
}

/**
 * Classify a task into a budget tier from its estimated pass@1 and task
 * value, before the noise guard. Boundaries: pass@1 > 0.65 → S; pass@1 <
 * 0.35 with high task value → L; everything else (including exactly 0.65,
 * exactly 0.35, and low-value tasks below 0.35) → M.
 */
export function classifyTier(passAt1: number, taskValue: TaskValue): BudgetTierName {
  const p = clamp01(passAt1);
  if (p > TIER_S_PASS_AT_1) {
    return 'S';
  }
  if (p < TIER_L_PASS_AT_1 && taskValue === 'high') {
    return 'L';
  }
  return 'M';
}

export interface GovernBudgetInput {
  /** Estimated pass@1 for the task, 0–1. */
  passAt1: number;
  taskValue: TaskValue;
  /**
   * Verifier precision measured on pilot data, 0–1. When omitted, the noise
   * guard does not apply (no pilot measurement exists).
   */
  verifierPrecision?: number;
}

/**
 * The governor: classify the task, then apply the verifier noise guard.
 * When a pilot precision was measured and is below `NOISE_GUARD_PRECISION`
 * (0.70), the budget locks to Tier S regardless of pass@1 and task value.
 * Returns the winning tier's spec.
 */
export function governBudget(input: GovernBudgetInput): BudgetTierSpec {
  if (
    input.verifierPrecision !== undefined &&
    clamp01(input.verifierPrecision) < NOISE_GUARD_PRECISION
  ) {
    return TIER_S_SPEC;
  }
  return specForTier(classifyTier(input.passAt1, input.taskValue));
}

/** Search bounds a tier asks for (`desired`) vs what the engine can grant (`effective`). */
export interface TierSearchBounds {
  /** Desired bounds from the tier spec (may exceed the engine caps). */
  desired: { maxNodes: number; maxBranching: number };
  /** Bounds the current engine can actually grant (clamped to `MAX_NODES` / `MAX_BRANCHING`). */
  effective: { maxNodes: number; maxBranching: number };
}

/**
 * Map a tier to OGTS search bounds. Desired `maxNodes` is the tier's node
 * range max; desired `maxBranching` is the tier's candidate max capped at
 * the engine's `MAX_BRANCHING`. `effective` clamps both to the engine's
 * current caps — Tier M (up to 20 nodes) and Tier L (30–60 nodes) exceed
 * `MAX_NODES` = 12 today, so their full budgets are aspirational until the
 * tree bounds are raised.
 */
export function tierSearchBounds(tier: BudgetTierName): TierSearchBounds {
  const spec = specForTier(tier);
  const desired = {
    maxNodes: spec.nodes.max,
    maxBranching: Math.min(spec.candidates.max, MAX_BRANCHING),
  };
  return {
    desired,
    effective: {
      maxNodes: Math.min(desired.maxNodes, MAX_NODES),
      maxBranching: Math.min(desired.maxBranching, MAX_BRANCHING),
    },
  };
}
