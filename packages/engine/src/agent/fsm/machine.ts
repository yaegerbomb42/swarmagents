/**
 * Step 6.2: Pure Transition Machine.
 *
 * Implements pure step(ctx, event): { ctx: nextCtx, nextState, effect }
 * Enforces:
 *   - Legal transition topology across all active and terminal states
 *   - Visit cap enforcement per state
 *   - Global transition ceiling (MAX_TRANSITIONS = 40)
 *   - Clean routing on retry, exhaustion, and failure
 */

import {
  type FsmContext,
  type FsmState,
  type ActiveFsmState,
  type FileSpan,
  type IntentSpec,
  type ReproTestArtifact,
  type CandidatePatch,
  type CandidateEvaluation,
  checkCapViolation,
  DEFAULT_STATE_VISIT_CAPS,
} from './types.js';
import type { EvidenceBundle } from '../../verify/evidence.js';

export type FsmEvent =
  | { type: 'INTAKE_COMPLETE'; localizationHints?: string[] }
  | {
      type: 'LOCALIZED';
      files: string[];
      spans: FileSpan[];
      confidence: number;
      exploredViaA4?: boolean;
    }
  | { type: 'CANNOT_LOCALIZE'; reason: string }
  | {
      type: 'SPECIFIED';
      intent?: IntentSpec;
      repro?: ReproTestArtifact;
      reproStatus: 'reproduced' | 'unavailable';
    }
  | { type: 'CANDIDATES_SYNTHESIZED'; candidates: CandidatePatch[] }
  | { type: 'SYNTHESIS_FAILED'; reason: string }
  | { type: 'VERIFICATION_COMPLETE'; evaluations: CandidateEvaluation[] }
  | { type: 'CANDIDATE_SELECTED'; candidateId: string; evidence?: EvidenceBundle }
  | { type: 'NO_VIABLE_CANDIDATE'; reason: string }
  | { type: 'FINALIZED'; verified: boolean; patchDiff: string }
  | { type: 'ABORT_REQUESTED'; reason: string; kind: 'env' | 'budget' }
  | {
      type: 'RETRY_STEP';
      targetState: ActiveFsmState;
      rungIncrement?: boolean;
      tombstone?: string;
    };

export type FsmEffect =
  | { type: 'RUN_INTAKE' }
  | { type: 'RUN_LOCALIZE' }
  | { type: 'RUN_SPECIFY' }
  | { type: 'RUN_SYNTHESIZE'; rung: number }
  | { type: 'RUN_VERIFY'; candidateIds: string[] }
  | { type: 'RUN_SELECT' }
  | { type: 'RUN_FINALIZE'; candidateId: string }
  | { type: 'TERMINATE'; state: FsmState; reason?: string };

export interface StepResult {
  ctx: FsmContext;
  nextState: FsmState;
  effect: FsmEffect;
}

/**
 * Pure transition function: takes current immutable context and incoming event,
 * applies visit/transition limits, and outputs the next context and required effect.
 */
export function step(
  currentCtx: FsmContext,
  event: FsmEvent,
  caps: Record<ActiveFsmState, number> = DEFAULT_STATE_VISIT_CAPS,
): StepResult {
  // If already at terminal state, no further transitions allowed
  if (
    currentCtx.state === 'DONE_VERIFIED' ||
    currentCtx.state === 'DONE_UNVERIFIED' ||
    currentCtx.state === 'DONE_NO_PATCH' ||
    currentCtx.state === 'ABORT_ENV' ||
    currentCtx.state === 'ABORT_BUDGET'
  ) {
    return {
      ctx: currentCtx,
      nextState: currentCtx.state,
      effect: { type: 'TERMINATE', state: currentCtx.state },
    };
  }

  // Handle explicit abort requests
  if (event.type === 'ABORT_REQUESTED') {
    const nextState: FsmState = event.kind === 'env' ? 'ABORT_ENV' : 'ABORT_BUDGET';
    const nextCtx = transition(currentCtx, nextState, event.type);
    nextCtx.error = event.reason;
    return {
      ctx: nextCtx,
      nextState,
      effect: { type: 'TERMINATE', state: nextState, reason: event.reason },
    };
  }

  // Compute proposed next state based on current state and event
  const resolution = resolveNextState(currentCtx, event);

  let targetState = resolution.targetState;
  let errorReason = resolution.errorReason;

  // Check visit cap & global transition ceiling
  const capCheck = checkCapViolation(currentCtx, targetState, caps);
  if (capCheck.violated) {
    // If budget/cap exhausted, fallback safely:
    // If we have a viable candidate in selection, we can finish unverified; otherwise abort budget.
    if (currentCtx.bestCandidateId || currentCtx.evaluations.some((e) => e.clean)) {
      targetState = 'DONE_UNVERIFIED';
    } else if (currentCtx.candidates.length === 0 && currentCtx.state === 'INTAKE') {
      targetState = 'DONE_NO_PATCH';
    } else {
      targetState = 'ABORT_BUDGET';
    }
    errorReason = capCheck.reason;
  }

  const nextCtx = transition(currentCtx, targetState, event.type);
  if (errorReason) {
    nextCtx.error = errorReason;
  }

  // Apply event-specific payload mutations to the next context
  applyEventArtifacts(nextCtx, event);

  // Determine effect for target state
  const effect = determineEffect(nextCtx, targetState);

  return {
    ctx: nextCtx,
    nextState: targetState,
    effect,
  };
}

function resolveNextState(
  ctx: FsmContext,
  event: FsmEvent,
): { targetState: FsmState; errorReason?: string } {
  switch (ctx.state) {
    case 'INTAKE':
      if (event.type === 'INTAKE_COMPLETE') return { targetState: 'A_LOCALIZE' };
      if (event.type === 'CANNOT_LOCALIZE')
        return { targetState: 'DONE_NO_PATCH', errorReason: event.reason };
      break;

    case 'A_LOCALIZE':
      if (event.type === 'LOCALIZED') return { targetState: 'B_SPECIFY' };
      if (event.type === 'CANNOT_LOCALIZE')
        return { targetState: 'DONE_NO_PATCH', errorReason: event.reason };
      break;

    case 'B_SPECIFY':
      if (event.type === 'SPECIFIED') return { targetState: 'C_SYNTHESIZE' };
      break;

    case 'C_SYNTHESIZE':
      if (event.type === 'CANDIDATES_SYNTHESIZED') return { targetState: 'D_VERIFY' };
      if (event.type === 'SYNTHESIS_FAILED') {
        // Can retry with rung increment if under cap
        return { targetState: 'C_SYNTHESIZE', errorReason: event.reason };
      }
      break;

    case 'D_VERIFY':
      if (event.type === 'VERIFICATION_COMPLETE') return { targetState: 'E_SELECT' };
      break;

    case 'E_SELECT':
      if (event.type === 'CANDIDATE_SELECTED') {
        return { targetState: 'F_FINALIZE' };
      }
      if (event.type === 'NO_VIABLE_CANDIDATE') {
        // Escalate rung and re-synthesize if rung < 4
        if (ctx.rung < 4) {
          return { targetState: 'C_SYNTHESIZE', errorReason: event.reason };
        }
        return { targetState: 'DONE_NO_PATCH', errorReason: event.reason };
      }
      break;

    case 'F_FINALIZE':
      if (event.type === 'FINALIZED') {
        return { targetState: event.verified ? 'DONE_VERIFIED' : 'DONE_UNVERIFIED' };
      }
      break;
  }

  // Handle general RETRY_STEP
  if (event.type === 'RETRY_STEP') {
    return { targetState: event.targetState };
  }

  // Unhandled event for current state
  return {
    targetState: 'ABORT_ENV',
    errorReason: `Illegal event '${event.type}' received in state '${ctx.state}'`,
  };
}

function transition(ctx: FsmContext, to: FsmState, eventType: string): FsmContext {
  const now = Date.now();
  const nextHistory = [...ctx.history, { from: ctx.state, to, event: eventType, timestamp: now }];

  const nextVisits = { ...ctx.visits };
  nextVisits[to] += 1;

  return {
    ...ctx,
    state: to,
    transitionsCount: ctx.transitionsCount + 1,
    visits: nextVisits,
    history: nextHistory,
  };
}

function applyEventArtifacts(ctx: FsmContext, event: FsmEvent): void {
  switch (event.type) {
    case 'LOCALIZED':
      ctx.localization = {
        files: event.files,
        spans: event.spans,
        confidence: event.confidence,
        ...(event.exploredViaA4 !== undefined ? { exploredViaA4: event.exploredViaA4 } : {}),
      };
      break;

    case 'SPECIFIED':
      ctx.specification = {
        ...(event.intent ? { intent: event.intent } : {}),
        ...(event.repro ? { repro: event.repro } : {}),
        reproStatus: event.reproStatus,
      };
      break;

    case 'CANDIDATES_SYNTHESIZED':
      ctx.candidates = event.candidates;
      break;

    case 'VERIFICATION_COMPLETE':
      ctx.evaluations = event.evaluations;
      break;

    case 'CANDIDATE_SELECTED':
      ctx.bestCandidateId = event.candidateId;
      if (event.evidence) {
        ctx.evidence = event.evidence;
      }
      break;

    case 'RETRY_STEP':
      if (event.rungIncrement && ctx.rung < 4) {
        ctx.rung += 1;
      }
      if (event.tombstone) {
        ctx.tombstones = [...ctx.tombstones, event.tombstone];
      }
      break;
  }
}

function determineEffect(ctx: FsmContext, state: FsmState): FsmEffect {
  switch (state) {
    case 'INTAKE':
      return { type: 'RUN_INTAKE' };
    case 'A_LOCALIZE':
      return { type: 'RUN_LOCALIZE' };
    case 'B_SPECIFY':
      return { type: 'RUN_SPECIFY' };
    case 'C_SYNTHESIZE':
      return { type: 'RUN_SYNTHESIZE', rung: ctx.rung };
    case 'D_VERIFY':
      return { type: 'RUN_VERIFY', candidateIds: ctx.candidates.map((c) => c.id) };
    case 'E_SELECT':
      return { type: 'RUN_SELECT' };
    case 'F_FINALIZE':
      return {
        type: 'RUN_FINALIZE',
        candidateId: ctx.bestCandidateId ?? ctx.candidates[0]?.id ?? '',
      };
    case 'DONE_VERIFIED':
    case 'DONE_UNVERIFIED':
    case 'DONE_NO_PATCH':
    case 'ABORT_ENV':
    case 'ABORT_BUDGET':
      return { type: 'TERMINATE', state, ...(ctx.error ? { reason: ctx.error } : {}) };
  }
}
