import { describe, it, expect } from 'vitest';
import {
  BUDGET_CRITICAL_PCT,
  BUDGET_WARN_PCT,
  creditsToUsd,
  evaluateBudget,
  formatCredits,
  formatRunway,
  formatUsd,
  spendPerHourCredits,
  usdToCredits,
} from './budgetAlarm';
import { CREDIT_USD } from './modelPricing';

describe('credit <-> USD conversion', () => {
  it('uses modelPricing.CREDIT_USD as the single source of truth', () => {
    expect(usdToCredits(1)).toBe(1 / CREDIT_USD);
    expect(usdToCredits(CREDIT_USD)).toBe(1);
  });

  it('round-trips', () => {
    expect(creditsToUsd(usdToCredits(2.5))).toBeCloseTo(2.5, 10);
  });

  it('degrades non-finite input to zero rather than NaN', () => {
    expect(usdToCredits(Number.NaN)).toBe(0);
    expect(creditsToUsd(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('spendPerHourCredits', () => {
  it('converts a USD/min burn into credits/hour', () => {
    // $0.002/min => 2 credits/min => 120 credits/hour
    expect(spendPerHourCredits(0.002)).toBeCloseTo(120, 6);
  });

  it('returns 0 for non-positive or non-finite burn', () => {
    expect(spendPerHourCredits(0)).toBe(0);
    expect(spendPerHourCredits(-1)).toBe(0);
    expect(spendPerHourCredits(Number.NaN)).toBe(0);
  });
});

describe('evaluateBudget', () => {
  it('reports unset when no limit is configured', () => {
    const r = evaluateBudget({ spentCredits: 100, limitCredits: 0 });
    expect(r.level).toBe('unset');
    expect(r.pct).toBe(0);
    expect(r.runwayMinutes).toBeNull();
    expect(r.message).toBe('No budget set');
  });

  it('reports ok below the warn threshold', () => {
    const r = evaluateBudget({ spentCredits: 10, limitCredits: 100 });
    expect(r.level).toBe('ok');
    expect(r.pct).toBe(10);
    expect(r.remainingCredits).toBe(90);
  });

  it(`reports warn at exactly ${BUDGET_WARN_PCT}%`, () => {
    expect(evaluateBudget({ spentCredits: 75, limitCredits: 100 }).level).toBe('warn');
    expect(evaluateBudget({ spentCredits: 74.9, limitCredits: 100 }).level).toBe('ok');
  });

  it(`reports critical at exactly ${BUDGET_CRITICAL_PCT}%`, () => {
    expect(evaluateBudget({ spentCredits: 90, limitCredits: 100 }).level).toBe('critical');
    // 89.9% is above warn but below critical.
    expect(evaluateBudget({ spentCredits: 89.9, limitCredits: 100 }).level).toBe('warn');
  });

  it('reports exceeded once spend reaches the limit', () => {
    const r = evaluateBudget({ spentCredits: 100, limitCredits: 100 });
    expect(r.level).toBe('exceeded');
    expect(r.pct).toBe(100);
    expect(r.remainingCredits).toBe(0);
  });

  it('reports exceeded with pct > 100 when overspent', () => {
    const r = evaluateBudget({ spentCredits: 250, limitCredits: 100 });
    expect(r.level).toBe('exceeded');
    expect(r.pct).toBe(250);
    expect(r.remainingCredits).toBe(0);
  });

  it('clamps negative spend to zero', () => {
    const r = evaluateBudget({ spentCredits: -50, limitCredits: 100 });
    expect(r.pct).toBe(0);
    expect(r.level).toBe('ok');
    expect(r.remainingCredits).toBe(100);
  });

  it('projects runway from the burn rate', () => {
    // 60 credits left, 120 credits/hour => 30 minutes
    const r = evaluateBudget({
      spentCredits: 40,
      limitCredits: 100,
      burnPerHourCredits: 120,
    });
    expect(r.runwayMinutes).toBeCloseTo(30, 6);
  });

  it('has no runway when the burn rate is unknown or idle', () => {
    expect(
      evaluateBudget({ spentCredits: 10, limitCredits: 100, burnPerHourCredits: 0 })
        .runwayMinutes,
    ).toBeNull();
    expect(evaluateBudget({ spentCredits: 10, limitCredits: 100 }).runwayMinutes).toBeNull();
  });

  it('reports zero runway once exhausted, even with no burn rate', () => {
    expect(
      evaluateBudget({ spentCredits: 120, limitCredits: 100 }).runwayMinutes,
    ).toBe(0);
  });

  it('never returns NaN for hostile input', () => {
    const r = evaluateBudget({
      spentCredits: Number.NaN,
      limitCredits: Number.NaN,
      burnPerHourCredits: Number.NaN,
    });
    expect(Number.isNaN(r.pct)).toBe(false);
    expect(Number.isNaN(r.remainingCredits)).toBe(false);
    expect(r.level).toBe('unset');
  });

  it('escalates the message with severity', () => {
    const ok = evaluateBudget({ spentCredits: 1, limitCredits: 100 }).message;
    const warn = evaluateBudget({ spentCredits: 80, limitCredits: 100 }).message;
    const crit = evaluateBudget({ spentCredits: 95, limitCredits: 100 }).message;
    const over = evaluateBudget({ spentCredits: 140, limitCredits: 100 }).message;
    expect(new Set([ok, warn, crit, over]).size).toBe(4);
    expect(over).toContain('exceeded');
  });
});

describe('formatUsd', () => {
  it.each([
    [0, '$0.00'],
    [0.0042, '$0.0042'],
    [12.5, '$12.50'],
    [2500, '$2.50k'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatUsd(input)).toBe(expected);
  });

  it('guards non-finite input', () => {
    expect(formatUsd(Number.NaN)).toBe('$—');
  });
});

describe('formatCredits', () => {
  it.each([
    [842, '842'],
    [12500, '12.5k'],
    [2_400_000, '2.40M'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatCredits(input)).toBe(expected);
  });
});

describe('formatRunway', () => {
  it.each([
    [null, '—'],
    [0, 'exhausted'],
    [0.5, '30s'],
    [45, '45m'],
    [200, '3h 20m'],
    [120, '2h'],
  ])('formats %s minutes as %s', (input, expected) => {
    expect(formatRunway(input)).toBe(expected);
  });

  it('guards non-finite input', () => {
    expect(formatRunway(Number.POSITIVE_INFINITY)).toBe('—');
  });
});