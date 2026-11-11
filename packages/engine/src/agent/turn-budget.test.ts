import { describe, expect, it } from 'vitest';
import {
  computeTurnBudgetPlan,
  parseTokensPerTurn,
  TurnBudgetAllocator,
  TIGHT_BUDGET,
} from './turn-budget.js';
import { TOKENS_PER_TURN_MAX, TOKENS_PER_TURN_MIN } from '../core/agent-levels.js';

const BUDGETS = [
  TOKENS_PER_TURN_MIN,
  1_500,
  2_000,
  TIGHT_BUDGET,
  TIGHT_BUDGET + 1,
  32_000,
  64_000,
  128_000,
  TOKENS_PER_TURN_MAX,
];

describe('computeTurnBudgetPlan', () => {
  it('keeps every ceiling inside the per-turn budget', () => {
    for (const budget of BUDGETS) {
      const plan = computeTurnBudgetPlan(budget);
      expect(plan.prefixCeiling, `prefix at ${budget}`).toBeGreaterThan(0);
      expect(plan.prefixCeiling, `prefix at ${budget}`).toBeLessThanOrEqual(budget);
      expect(plan.toolOutputCeiling, `tool output at ${budget}`).toBeGreaterThan(0);
      expect(plan.toolOutputCeiling, `tool output at ${budget}`).toBeLessThanOrEqual(budget);
      expect(plan.compactionTarget, `compaction at ${budget}`).toBeGreaterThan(0);
      expect(plan.compactionTarget, `compaction at ${budget}`).toBeLessThanOrEqual(budget);
      expect(plan.minIrreducibleCore, `core at ${budget}`).toBeLessThanOrEqual(budget);
      // The prefix must at least have room for the irreducible core it contains.
      expect(plan.prefixCeiling, `prefix vs core at ${budget}`).toBeGreaterThanOrEqual(
        plan.minIrreducibleCore,
      );
    }
  });

  it('is deterministic and never exceeds the hard ceiling', () => {
    const a = computeTurnBudgetPlan(32_000);
    const b = computeTurnBudgetPlan(32_000);
    expect(a).toEqual(b);
    expect(a.prefixCeiling).toBeLessThanOrEqual(5_440);
  });

  it('clamps out-of-range budgets instead of inventing a plan', () => {
    const low = computeTurnBudgetPlan(1);
    const high = computeTurnBudgetPlan(Number.MAX_SAFE_INTEGER);
    expect(low.budget).toBe(TOKENS_PER_TURN_MIN);
    expect(high.budget).toBe(TOKENS_PER_TURN_MAX);
    expect(low.heavy).toBe(true);
  });
});

describe('TurnBudgetAllocator', () => {
  it('returns the same cached plan for the same budget', () => {
    const allocator = new TurnBudgetAllocator();
    expect(allocator.planFor(16_000)).toBe(allocator.planFor(16_000));
    expect(allocator.planFor(16_000)).not.toBe(allocator.planFor(32_000));
  });
});

describe('parseTokensPerTurn', () => {
  it('accepts plain numbers and k shorthand', () => {
    expect(parseTokensPerTurn('4096')).toBe(4_096);
    expect(parseTokensPerTurn('16k')).toBe(16_000);
    expect(parseTokensPerTurn('1.5k')).toBe(1_500);
  });

  it('clamps and rejects malformed input', () => {
    expect(parseTokensPerTurn('1')).toBe(TOKENS_PER_TURN_MIN);
    expect(parseTokensPerTurn('999k')).toBe(TOKENS_PER_TURN_MAX);
    expect(() => parseTokensPerTurn('lots')).toThrow();
    expect(() => parseTokensPerTurn('-4k')).toThrow();
  });
});
