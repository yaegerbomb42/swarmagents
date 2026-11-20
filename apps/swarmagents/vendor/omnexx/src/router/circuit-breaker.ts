/**
 * 3-Tier Escalation Circuit Breaker (Step 4.4).
 *
 * Tracks consecutive failures per task and tier. When a tier exhausts its
 * `MAX_CALLS_PER_TIER` budget (2 attempts), the breaker recommends escalation
 * to the next tier. Four automated triggers cause immediate escalation without
 * waiting for the budget:
 *
 *   1. SYNTAX_ERROR    — preflight intercepted a syntax error
 *   2. TEST_REGRESSION — a test suite reports a new failure
 *   3. PARSE_FAILURE   — model output violates structured tool schema
 *   4. ITERATION_EXCEEDED — sub-task turn count exceeds budget
 *
 * Tier 3 is terminal: it never escalates. On failure it marks the task as
 * blocked with structured triage output the caller can surface.
 */

import type { CascadeTier } from './cascade-router.js';
import { MAX_CALLS_PER_TIER } from './cascade-router.js';

export { MAX_CALLS_PER_TIER };

export const ESCALATION_TRIGGERS = [
  'SYNTAX_ERROR',
  'TEST_REGRESSION',
  'PARSE_FAILURE',
  'ITERATION_EXCEEDED',
] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

export interface FailureContext {
  tier: CascadeTier;
  failedAttempts: number;
  lastError?: string | undefined;
  diagnosticCodes?: string[] | undefined;
}

export interface EscalationDecision {
  escalate: boolean;
  targetTier: CascadeTier;
  reason?: string;
}

export interface BlockedResult {
  blocked: true;
  taskId: string;
  tier: 3;
  failedAttempts: number;
  lastError?: string | undefined;
  diagnosticCodes: string[];
  triage: string;
}

interface TaskState {
  /** Consecutive failures at each tier since the last success or reset. */
  failures: Record<CascadeTier, number>;
  /** The most recent error string at each tier. */
  lastError: Record<CascadeTier, string | undefined>;
  /** Accumulated diagnostic codes across all tiers for triage output. */
  diagnosticCodes: string[];
  /** Immediate-escalation triggers that have fired for this task. */
  triggers: EscalationTrigger[];
}

function freshState(): TaskState {
  return {
    failures: { 1: 0, 2: 0, 3: 0 },
    lastError: { 1: undefined, 2: undefined, 3: undefined },
    diagnosticCodes: [],
    triggers: [],
  };
}

function nextTier(tier: CascadeTier): CascadeTier {
  if (tier === 1) return 2;
  if (tier === 2) return 3;
  return 3; // terminal
}

/** Classify an error string into an immediate-escalation trigger, if any. */
function classifyTrigger(error: string | undefined): EscalationTrigger | undefined {
  if (!error) return undefined;
  const lower = error.toLowerCase();
  if (
    /\bsyntax[ _-]?error\b/.test(lower) ||
    /\bparse error\b/.test(lower) ||
    /\bunexpected token\b/.test(lower) ||
    /\bast gate\b/.test(lower)
  ) {
    return 'SYNTAX_ERROR';
  }
  if (
    /\btest[s ]?(fail|regress|broke)\b/.test(lower) ||
    /\bnew failure\b/.test(lower) ||
    /\btest[_ ]?regression\b/.test(lower) ||
    /\bfailing test\b/.test(lower)
  ) {
    return 'TEST_REGRESSION';
  }
  if (
    /\bparse[_ ]?failure\b/.test(lower) ||
    /\bmalformed\b/.test(lower) ||
    /\binvalid tool\b/.test(lower) ||
    /\bschema violat\b/.test(lower) ||
    /\btool schema\b/.test(lower)
  ) {
    return 'PARSE_FAILURE';
  }
  if (
    /\biteration[s ]?exceeded\b/.test(lower) ||
    /\bturn[_ ]?budget\b/.test(lower) ||
    /\bmax[_ ]?turns\b/.test(lower) ||
    /\bturn[_ ]?limit\b/.test(lower)
  ) {
    return 'ITERATION_EXCEEDED';
  }
  return undefined;
}

/**
 * Tracks consecutive failures per task and tier. When the budget is exhausted
 * or an immediate trigger fires, `shouldEscalate` recommends promotion to the
 * next tier. Tier 3 failures are terminal — `getBlockedResult` returns
 * structured triage output the caller can surface to the user or the agent loop.
 */
export class CascadeCircuitBreaker {
  private readonly tasks = new Map<string, TaskState>();

  private stateFor(taskId: string): TaskState {
    let state = this.tasks.get(taskId);
    if (!state) {
      state = freshState();
      this.tasks.set(taskId, state);
    }
    return state;
  }

  /** Record a failure at the task's current tier. */
  recordFailure(taskId: string, tier: CascadeTier, error?: string): void {
    const state = this.stateFor(taskId);
    state.failures[tier]++;
    if (error !== undefined) state.lastError[tier] = error;

    const trigger = classifyTrigger(error);
    if (trigger && !state.triggers.includes(trigger)) {
      state.triggers.push(trigger);
    }

    // Extract diagnostic codes from the error string (e.g. TS2322, E0308, SyntaxError).
    if (error) {
      const codes = error.match(/\b(?:TS\d{4,5}|E\d{4}|SyntaxError|ParseError)\b/g);
      if (codes) {
        for (const code of codes) {
          if (!state.diagnosticCodes.includes(code)) {
            state.diagnosticCodes.push(code);
          }
        }
      }
    }
  }

  /** Record a success, clearing the failure counter for the given tier. */
  recordSuccess(taskId: string, tier: CascadeTier): void {
    const state = this.stateFor(taskId);
    state.failures[tier] = 0;
    state.lastError[tier] = undefined;
    // Don't clear triggers — they inform future decisions even after a partial recovery.
  }

  /**
   * Whether the task should escalate from `currentTier`.
   *
   * Escalation happens when:
   * 1. An immediate trigger fired on this attempt (Tier 1 always escalates on any trigger).
   * 2. Consecutive failures at this tier reach `MAX_CALLS_PER_TIER`.
   *
   * Tier 3 never escalates: `escalate` is always `false` (use `getBlockedResult` instead).
   */
  shouldEscalate(taskId: string, currentTier: CascadeTier): EscalationDecision {
    const state = this.stateFor(taskId);
    const failures = state.failures[currentTier];
    const target = nextTier(currentTier);

    // Tier 3 is terminal — never escalate.
    if (currentTier === 3) {
      return { escalate: false, targetTier: 3 };
    }

    // Tier 1: any failure escalates immediately (it's deterministic — retrying is pointless).
    if (currentTier === 1 && failures > 0) {
      const trigger = state.triggers[state.triggers.length - 1];
      const lastErr = state.lastError[1];
      const reason = trigger
        ? `immediate escalation: ${trigger}${lastErr ? ` (${lastErr.slice(0, 120)})` : ''}`
        : `tier 1 failure: deterministic path cannot resolve${lastErr ? ` (${lastErr.slice(0, 120)})` : ''}`;
      return { escalate: true, targetTier: target, reason };
    }

    // Immediate trigger at tier 2.
    const latestTrigger = state.triggers[state.triggers.length - 1];
    if (currentTier === 2 && latestTrigger && failures > 0) {
      return {
        escalate: true,
        targetTier: target,
        reason: `immediate escalation: ${latestTrigger}${state.lastError[2] ? ` (${state.lastError[2].slice(0, 120)})` : ''}`,
      };
    }

    // Budget exhaustion.
    if (failures >= MAX_CALLS_PER_TIER) {
      return {
        escalate: true,
        targetTier: target,
        reason: `${String(failures)} consecutive failures at tier ${String(currentTier)} (budget: ${String(MAX_CALLS_PER_TIER)})`,
      };
    }

    return { escalate: false, targetTier: currentTier };
  }

  /** Current failure context for a task at a tier, for diagnostic/logging use. */
  getFailureContext(taskId: string, tier: CascadeTier): FailureContext {
    const state = this.stateFor(taskId);
    return {
      tier,
      failedAttempts: state.failures[tier],
      lastError: state.lastError[tier],
      diagnosticCodes: state.diagnosticCodes.length > 0 ? [...state.diagnosticCodes] : undefined,
    };
  }

  /**
   * Structured triage output when Tier 3 (the terminal tier) has failed.
   * Returns `undefined` if Tier 3 has not failed for this task.
   */
  getBlockedResult(taskId: string): BlockedResult | undefined {
    const state = this.tasks.get(taskId);
    if (!state || state.failures[3] === 0) return undefined;

    const lastErr = state.lastError[3] ?? 'unknown error';
    const codes = [...state.diagnosticCodes];
    const triggers = state.triggers.length > 0 ? state.triggers.join(', ') : 'none';
    const history = ([1, 2, 3] as const)
      .filter((t) => state.failures[t] > 0 || state.lastError[t])
      .map(
        (t) =>
          `  tier ${String(t)}: ${String(state.failures[t])} failure(s)${state.lastError[t] ? ` — ${state.lastError[t].slice(0, 200)}` : ''}`,
      )
      .join('\n');

    return {
      blocked: true,
      taskId,
      tier: 3,
      failedAttempts: state.failures[3],
      lastError: state.lastError[3],
      diagnosticCodes: codes,
      triage: [
        `BLOCKED: task "${taskId}" failed at all tiers.`,
        `Last error: ${lastErr.slice(0, 300)}`,
        `Escalation triggers: ${triggers}`,
        `Diagnostic codes: ${codes.length > 0 ? codes.join(', ') : 'none'}`,
        `Failure history:\n${history}`,
        'Action: requires human intervention or a different approach.',
      ].join('\n'),
    };
  }

  /** Clear all failure state for a task (e.g. after a successful completion or re-plan). */
  reset(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /** Number of tracked tasks (testing/observability). */
  get size(): number {
    return this.tasks.size;
  }
}
