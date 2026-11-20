// Team Mode — the provider policy a lane inherits from its user.
//
// A lane is a run of its own: it talks to a provider with the user's own keys
// (directly, or through the LLM proxy). It must obey the same routing rules a
// normal run obeys, so the user stays in control of what the team spends:
//
//   - allowPaidProviders = false -> a paid provider is never used.
//   - perRunBudgetUsd           -> one team run may not spend more than this.
//   - perDayBudgetUsd           -> one user's team runs may not spend more
//                                  than this on a UTC day.
//
// The spend ledger is process-local (like the approval store): a restart
// forgets the team's spend, which can only ever let a team run spend *more*
// after a restart, never less. The ledger counts the team's own spend only,
// so a run that is billed through the LLM proxy is never counted twice.

import { readUserSettings, routerProviders } from "../providers";

/** What the user's routing settings allow a lane to do. */
export interface LanePolicy {
  /** May a lane use a provider that is not marked free? */
  allowPaid: boolean;
  /** USD cap for one team run (null = uncapped). */
  perRunBudgetUsd: number | null;
  /** USD cap per UTC day (null = uncapped). */
  perDayBudgetUsd: number | null;
}

/** The routing policy for one user's lanes. */
export function readLanePolicy(userId: string): LanePolicy {
  const settings = readUserSettings(userId);
  return {
    allowPaid: settings.allowPaidProviders !== false,
    perRunBudgetUsd: settings.perRunBudgetUsd ?? null,
    perDayBudgetUsd: settings.perDayBudgetUsd ?? null,
  };
}

/**
 * True when the provider costs money. A provider the user did not save is
 * treated as paid: with paid providers switched off, an unknown provider must
 * not slip through.
 */
export function isPaidProvider(userId: string, providerId: string): boolean {
  const config = routerProviders(userId).find((candidate) => candidate.id === providerId);
  if (!config) return true;
  return config.isFree !== true;
}

/** UTC day key ("2026-11-12"), the bucket the daily cap resets on. */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

interface DaySpend {
  day: string;
  usd: number;
}

/**
 * Paid spend made by team runs: per run (the perRunBudgetUsd bucket) and per
 * user per UTC day (the perDayBudgetUsd bucket).
 */
export class LaneSpendLedger {
  private readonly runSpend = new Map<string, number>();
  private readonly daySpend = new Map<string, DaySpend>();

  /** Add a lane's paid spend to the run and day buckets. */
  record(runId: string, userId: string, costUsd: number): void {
    const usd = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
    if (usd === 0) return;
    this.runSpend.set(runId, (this.runSpend.get(runId) ?? 0) + usd);
    const day = utcDay();
    const entry = this.daySpend.get(userId);
    if (!entry || entry.day !== day) this.daySpend.set(userId, { day, usd });
    else entry.usd += usd;
  }

  /** USD spent by one team run so far. */
  runSpendUsd(runId: string): number {
    return this.runSpend.get(runId) ?? 0;
  }

  /** USD this user's team runs spent today (UTC). */
  daySpendUsd(userId: string, now: number = Date.now()): number {
    const entry = this.daySpend.get(userId);
    if (!entry || entry.day !== utcDay(now)) return 0;
    return entry.usd;
  }

  /** Test hook: drop every recorded spend. */
  clear(): void {
    this.runSpend.clear();
    this.daySpend.clear();
  }
}

const g = globalThis as typeof globalThis & { __swarmLaneSpendLedger?: LaneSpendLedger };

/** Process-wide ledger shared by every team run (like the approval store). */
export function getLaneSpendLedger(): LaneSpendLedger {
  if (!g.__swarmLaneSpendLedger) g.__swarmLaneSpendLedger = new LaneSpendLedger();
  return g.__swarmLaneSpendLedger;
}

/** Test hook: swap the process-wide ledger. */
export function setLaneSpendLedgerForTesting(ledger: LaneSpendLedger | null): void {
  g.__swarmLaneSpendLedger = ledger ?? undefined;
}

export interface LaneProviderVerdict {
  /** May the lane use this provider? */
  allowed: boolean;
  /** Why the provider was refused (empty when allowed). */
  reason: string;
}

/**
 * May a lane use the given provider? A paid provider is refused when the user
 * switched paid providers off, or when the run's / the day's paid-spend cap is
 * already spent. Free providers are never blocked by the budget.
 */
export function laneProviderVerdict(args: {
  policy: LanePolicy;
  ledger: LaneSpendLedger;
  userId: string;
  runId: string;
  providerId: string;
  /** Cached "does this provider cost money?" lookup (the harness caches it). */
  isPaid?: (providerId: string) => boolean;
}): LaneProviderVerdict {
  const { policy, ledger, userId, runId, providerId } = args;
  const paid = args.isPaid ? args.isPaid(providerId) : isPaidProvider(userId, providerId);
  if (!paid) return { allowed: true, reason: "" };

  if (!policy.allowPaid) {
    return {
      allowed: false,
      reason: `paid provider "${providerId}" is disabled for this account (allowPaidProviders is off).`,
    };
  }

  if (policy.perRunBudgetUsd !== null) {
    const spent = ledger.runSpendUsd(runId);
    if (spent >= policy.perRunBudgetUsd) {
      return {
        allowed: false,
        reason: `team run budget spent: $${spent.toFixed(4)} of $${policy.perRunBudgetUsd.toFixed(4)}.`,
      };
    }
  }

  if (policy.perDayBudgetUsd !== null) {
    const spent = ledger.daySpendUsd(userId);
    if (spent >= policy.perDayBudgetUsd) {
      return {
        allowed: false,
        reason: `daily budget spent: $${spent.toFixed(4)} of $${policy.perDayBudgetUsd.toFixed(4)}.`,
      };
    }
  }

  return { allowed: true, reason: "" };
}
