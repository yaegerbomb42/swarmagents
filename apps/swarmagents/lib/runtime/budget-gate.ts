/**
 * budget-gate.ts — per-run budget accounting and the "budget reached, continue?"
 * gate.
 *
 * A user caps what one run may spend with the `perRunBudgetUsd` setting
 * (lib/providers/settings.ts). The router refuses paid providers once a run
 * has spent that much (see lib/router/router.ts), which used to end the run
 * with a bare error. This module gives that moment a face:
 *
 *   - it keeps the running total of what a run has spent,
 *   - it publishes the projected spend so the UI can warn at 80% of the cap,
 *   - it holds the request that hit the cap until the user answers, so the
 *     agent pauses instead of dying, and
 *   - it records that the user chose to continue, which lifts the cap for the
 *     rest of that run.
 *
 * The state is process-local (like the approval store): a restart forgets the
 * pending decision, and the run's own request then fails with a clear
 * "budget reached" error instead of hanging.
 */

import { randomUUID } from "node:crypto";

/** What the user answered when a run hit its budget. */
export type BudgetVerdict = "continue" | "stop";

/** Lifecycle of a pending budget decision. */
export type BudgetDecisionStatus = "pending" | "continued" | "stopped" | "expired";

/** A run waiting for the user to answer the budget question. */
export interface PendingBudgetDecision {
  id: string;
  runId: string;
  userId: string;
  /** USD the run had spent when it hit the cap. */
  spentUsd: number;
  /** The cap that was hit. */
  limitUsd: number;
  /** spentUsd plus the expected cost of the next call. */
  projectedUsd: number;
  createdAt: number;
  expiresAt: number;
  status: BudgetDecisionStatus;
  decidedAt?: number;
}

/** Numbers the gate reports while a run is going. */
export interface BudgetHoldInfo {
  spentUsd: number;
  limitUsd: number;
  projectedUsd: number;
  expectedNextCallUsd: number;
}

const DEFAULT_TTL_SEC = 300;

function defaultTtlMs(): number {
  const raw = Number(process.env.SWARM_BUDGET_HOLD_TTL_SEC);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw * 1000);
  return DEFAULT_TTL_SEC * 1000;
}

interface RunSpend {
  usd: number;
  calls: number;
}

interface Waiter {
  resolve: (verdict: BudgetVerdict) => void;
}
/**
 * Process-wide budget gate: per-run spend totals, the pending "continue?"
 * decisions, and the runs whose cap the user lifted.
 */
export class BudgetGate {
  private readonly spend = new Map<string, RunSpend>();
  private readonly exempt = new Set<string>();
  private readonly pending = new Map<string, PendingBudgetDecision>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly warned = new Set<string>();
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  /** True when the gate already knows this run's spend. */
  known(runId: string): boolean {
    return this.spend.has(runId);
  }

  /** Seed a run's spend (e.g. from the durable log after a restart). */
  seedSpend(runId: string, usd: number, calls = 1): void {
    const value = Number.isFinite(usd) && usd > 0 ? usd : 0;
    this.spend.set(runId, { usd: value, calls: Math.max(0, calls) });
  }

  /** Record what one successful provider call cost. */
  noteSpend(runId: string, usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    const entry = this.spend.get(runId) ?? { usd: 0, calls: 0 };
    entry.usd += usd;
    entry.calls += 1;
    this.spend.set(runId, entry);
  }

  /** USD a run has spent. */
  spendFor(runId: string): number {
    return this.spend.get(runId)?.usd ?? 0;
  }

  /** Mean cost of the run's successful, priced calls. */
  expectedNextCallUsd(runId: string): number {
    const entry = this.spend.get(runId);
    if (!entry || entry.calls === 0) return 0;
    return entry.usd / entry.calls;
  }

  /** True when the user lifted this run's cap. */
  isExempt(runId: string): boolean {
    return this.exempt.has(runId);
  }

  /** Lift the cap for a run (the user chose to continue). */
  exemptRun(runId: string): void {
    this.exempt.add(runId);
  }

  /** True when this run already got its "80% of the budget" warning. */
  hasWarned(runId: string): boolean {
    return this.warned.has(runId);
  }

  /** Mark a run as warned so the warning is published once. */
  markWarned(runId: string): void {
    this.warned.add(runId);
  }

  /** The pending decision for a run, if it is waiting for an answer. */
  pendingFor(runId: string): PendingBudgetDecision | undefined {
    return this.pending.get(runId);
  }

  /**
   * Hold a run until the user answers. Resolves "continue" when the user
   * lifts the cap and "stop" when they refuse or nobody answers in time.
   */
  hold(runId: string, userId: string, info: BudgetHoldInfo): Promise<BudgetVerdict> {
    const existing = this.pending.get(runId);
    if (existing && existing.status === "pending") {
      return this.waitFor(runId);
    }
    const now = this.now();
    const ttlMs = this.ttlMs ?? defaultTtlMs();
    const decision: PendingBudgetDecision = {
      id: `bgt_${randomUUID()}`,
      runId,
      userId,
      spentUsd: info.spentUsd,
      limitUsd: info.limitUsd,
      projectedUsd: info.projectedUsd,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: "pending",
    };
    this.pending.set(runId, decision);

    const timer = setTimeout(() => {
      this.timers.delete(runId);
      const current = this.pending.get(runId);
      if (current && current.status === "pending") {
        current.status = "expired";
        current.decidedAt = this.now();
        this.drainWaiters(runId, "stop");
      }
    }, ttlMs);
    timer.unref?.();
    this.timers.set(runId, timer);

    return this.waitFor(runId);
  }

  /** Promise that settles when the pending decision is answered. */
  private waitFor(runId: string): Promise<BudgetVerdict> {
    return new Promise<BudgetVerdict>((resolve) => {
      const list = this.waiters.get(runId) ?? [];
      list.push({ resolve });
      this.waiters.set(runId, list);
    });
  }

  /** Settle every promise waiting on a run's decision. */
  private drainWaiters(runId: string, verdict: BudgetVerdict): void {
    const list = this.waiters.get(runId);
    if (!list) return;
    this.waiters.delete(runId);
    for (const waiter of list) {
      try {
        waiter.resolve(verdict);
      } catch {
        // A broken waiter must never hold up the decision.
      }
    }
  }

  /**
   * Answer a pending decision. Returns false when there was nothing pending.
   * "continue" lifts the run's cap for the rest of the run.
   */
  resolve(runId: string, verdict: BudgetVerdict): boolean {
    const decision = this.pending.get(runId);
    if (!decision || decision.status !== "pending") return false;
    decision.status = verdict === "continue" ? "continued" : "stopped";
    decision.decidedAt = this.now();
    this.clearTimer(runId);
    if (verdict === "continue") this.exempt.add(runId);
    this.drainWaiters(runId, verdict);
    return true;
  }

  /** Drop a run's pending decision (the run ended or was cancelled). */
  release(runId: string): void {
    const decision = this.pending.get(runId);
    if (decision && decision.status === "pending") {
      decision.status = "expired";
      decision.decidedAt = this.now();
      this.drainWaiters(runId, "stop");
    }
    this.clearTimer(runId);
    this.pending.delete(runId);
  }

  /** Test hook: drop all state. */
  clear(): void {
    for (const runId of this.timers.keys()) this.clearTimer(runId);
    this.spend.clear();
    this.exempt.clear();
    this.pending.clear();
    this.waiters.clear();
    this.warned.clear();
  }

  private clearTimer(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(runId);
    }
  }
}

const g = globalThis as typeof globalThis & { __swarmBudgetGate?: BudgetGate };

/** The process-wide gate shared by the gateway and the budget route. */
export function getBudgetGate(): BudgetGate {
  if (!g.__swarmBudgetGate) g.__swarmBudgetGate = new BudgetGate();
  return g.__swarmBudgetGate;
}

/** Test hook: swap the process-wide gate. */
export function setBudgetGateForTesting(gate: BudgetGate | null): void {
  g.__swarmBudgetGate = gate ?? undefined;
}
