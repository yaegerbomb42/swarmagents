/**
 * Fleet budget evaluation — pure logic for the spend/budget HUD.
 *
 * Kept free of React so threshold behaviour (warn / critical / exceeded),
 * credit<->USD conversion and runway projection can be unit-tested directly.
 *
 * Credit economics are owned by `modelPricing.ts` — `CREDIT_USD` is the single
 * source of truth for the credit/USD rate. Never re-derive it here.
 */

import { CREDIT_USD } from './modelPricing';

export type BudgetLevel = 'ok' | 'warn' | 'critical' | 'exceeded' | 'unset';

/** Spend at or above this % of the limit raises a warning. */
export const BUDGET_WARN_PCT = 75;
/** Spend at or above this % of the limit is critical. */
export const BUDGET_CRITICAL_PCT = 90;

/** USD spend -> credits. */
export function usdToCredits(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return usd / CREDIT_USD;
}

/** Credits -> USD. */
export function creditsToUsd(credits: number): number {
  if (!Number.isFinite(credits)) return 0;
  return credits * CREDIT_USD;
}

/**
 * Converts a USD-per-minute burn rate into credits per hour.
 * This is the figure the engine's `costPerMinute` maps onto.
 */
export function spendPerHourCredits(usdPerMinute: number): number {
  if (!Number.isFinite(usdPerMinute) || usdPerMinute <= 0) return 0;
  return usdToCredits(usdPerMinute) * 60;
}

export interface BudgetInput {
  /** Credits already consumed against this budget. */
  spentCredits: number;
  /** Configured ceiling in credits. `<= 0` means no budget configured. */
  limitCredits: number;
  /** Current burn in credits/hour, if a rate is known. */
  burnPerHourCredits?: number | null;
}

export interface BudgetEvaluation {
  /** Spend as a percentage of the limit. Can exceed 100. */
  pct: number;
  level: BudgetLevel;
  /** Credits left before the ceiling; 0 when exceeded. */
  remainingCredits: number;
  /** Minutes of runway at the current burn rate; null when unknowable. */
  runwayMinutes: number | null;
  /** Short, human-readable status line. */
  message: string;
}

/**
 * Evaluates spend against a budget ceiling.
 *
 * Deliberately never throws and never returns NaN/Infinity, because this feeds
 * a live HUD: an unconfigured or freshly-reset budget must render cleanly.
 */
export function evaluateBudget({
  spentCredits,
  limitCredits,
  burnPerHourCredits = null,
}: BudgetInput): BudgetEvaluation {
  const spent = Number.isFinite(spentCredits) ? Math.max(0, spentCredits) : 0;
  const limit = Number.isFinite(limitCredits) ? limitCredits : 0;

  if (limit <= 0) {
    return {
      pct: 0,
      level: 'unset',
      remainingCredits: 0,
      runwayMinutes: null,
      message: 'No budget set',
    };
  }

  const pct = (spent / limit) * 100;
  const remaining = Math.max(0, limit - spent);

  let level: BudgetLevel;
  if (spent >= limit) level = 'exceeded';
  else if (pct >= BUDGET_CRITICAL_PCT) level = 'critical';
  else if (pct >= BUDGET_WARN_PCT) level = 'warn';
  else level = 'ok';

  let runwayMinutes: number | null = null;
  if (burnPerHourCredits && burnPerHourCredits > 0 && remaining > 0) {
    runwayMinutes = remaining / (burnPerHourCredits / 60);
  } else if (remaining <= 0) {
    runwayMinutes = 0;
  }

  const message =
    level === 'exceeded'
      ? 'Budget exceeded — runs will be blocked at launch'
      : level === 'critical'
        ? 'Critical spend — nearing the budget ceiling'
        : level === 'warn'
          ? 'Spend elevated — review the run before launching'
          : 'Spend within budget';

  return { pct, level, remainingCredits: remaining, runwayMinutes, message };
}

/** `$0.0000` for sub-cent precision, `$12.50` once meaningfully large. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '$—';
  const abs = Math.abs(usd);
  if (abs === 0) return '$0.00';
  if (abs < 0.01) return `$${usd.toFixed(4)}`;
  if (abs < 1000) return `$${usd.toFixed(2)}`;
  return `$${(usd / 1000).toFixed(2)}k`;
}

/** Compact credit display: `842`, `12.5k`, `2.40M`. */
export function formatCredits(credits: number): string {
  if (!Number.isFinite(credits)) return '—';
  const abs = Math.abs(credits);
  if (abs >= 1_000_000) return `${(credits / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(credits / 1_000).toFixed(1)}k`;
  if (abs >= 1_000) return `${credits.toFixed(0)}`;
  if (abs >= 100) return `${Math.round(credits)}`;
  return `${credits.toFixed(1)}`;
}

/** `3h 20m`, `45m`, `28s`, or an em-dash when the runway is unknowable. */
export function formatRunway(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';
  if (minutes <= 0) return 'exhausted';
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}