/**
 * Step 6.1: FSM State Schema, Context & Visit Caps.
 *
 * Defines the deterministic Finite State Machine (FSM) architecture for issue resolution:
 *   - Active states: INTAKE, A_LOCALIZE, B_SPECIFY, C_SYNTHESIZE, D_VERIFY, E_SELECT, F_FINALIZE
 *   - Terminal states: DONE_VERIFIED, DONE_UNVERIFIED, DONE_NO_PATCH, ABORT_ENV, ABORT_BUDGET
 *   - Visit caps & global transition guard (MAX_TRANSITIONS = 40)
 *   - Crash-safe context schema with Zod serialization
 */

import { z } from 'zod';
import type { EvidenceBundle } from '../../verify/evidence.js';

export const ACTIVE_FSM_STATES = [
  'INTAKE',
  'A_LOCALIZE',
  'B_SPECIFY',
  'C_SYNTHESIZE',
  'D_VERIFY',
  'E_SELECT',
  'F_FINALIZE',
] as const;

export const TERMINAL_FSM_STATES = [
  'DONE_VERIFIED',
  'DONE_UNVERIFIED',
  'DONE_NO_PATCH',
  'ABORT_ENV',
  'ABORT_BUDGET',
] as const;

export const ALL_FSM_STATES = [...ACTIVE_FSM_STATES, ...TERMINAL_FSM_STATES] as const;

export type ActiveFsmState = (typeof ACTIVE_FSM_STATES)[number];
export type TerminalFsmState = (typeof TERMINAL_FSM_STATES)[number];
export type FsmState = (typeof ALL_FSM_STATES)[number];

export const MAX_TRANSITIONS = 40;

export const DEFAULT_STATE_VISIT_CAPS: Record<ActiveFsmState, number> = {
  INTAKE: 2,
  A_LOCALIZE: 4,
  B_SPECIFY: 4,
  C_SYNTHESIZE: 5,
  D_VERIFY: 5,
  E_SELECT: 5,
  F_FINALIZE: 2,
};

export interface FileSpan {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  confidence?: number;
}

export interface LocalizationArtifact {
  files: string[];
  spans: FileSpan[];
  confidence: number;
  exploredViaA4?: boolean;
}

export interface IntentSpec {
  rootCause: string;
  fixStrategy: string;
  edgeCases: string[];
}

export interface ReproTestArtifact {
  path: string;
  code: string;
  sha256: string;
  admitted: boolean;
  baselineFailCount: number;
}

export interface SpecificationArtifact {
  intent?: IntentSpec;
  repro?: ReproTestArtifact;
  reproStatus: 'reproduced' | 'unavailable' | 'untested';
}

export interface CandidatePatch {
  id: string;
  rung: number;
  temperature: number;
  hypothesis: string;
  diff: string;
  filesTouched: string[];
  syntaxValid: boolean;
  diagnosticsDelta: number;
}

export interface CandidateEvaluation {
  candidateId: string;
  clean: boolean;
  newFailuresCount: number;
  reproPassed: boolean;
  extraCasesFailed: number;
  literalLeaksCount: number;
  clusterSize: number;
  diffLines: number;
  filesTouched: number;
  index: number;
}

export interface TransitionRecord {
  from: FsmState;
  to: FsmState;
  event: string;
  timestamp: number;
}

export interface FsmContext {
  runId: string;
  repoRoot: string;
  baseSha: string;
  inputHash: string;
  issue: {
    id: string;
    title?: string;
    problemStatement: string;
  };
  state: FsmState;
  transitionsCount: number;
  visits: Record<FsmState, number>;
  history: TransitionRecord[];
  rung: number; // 0 to 4
  localization?: LocalizationArtifact;
  specification?: SpecificationArtifact;
  candidates: CandidatePatch[];
  evaluations: CandidateEvaluation[];
  bestCandidateId?: string;
  evidence?: EvidenceBundle;
  tombstones: string[]; // Invalid paths, failed hypotheses, or rejected strategies
  error?: string;
}

export const fsmStateSchema = z.enum(ALL_FSM_STATES);

export const transitionRecordSchema = z.object({
  from: fsmStateSchema,
  to: fsmStateSchema,
  event: z.string(),
  timestamp: z.number(),
});

export const fileSpanSchema = z.object({
  path: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  symbol: z.string().optional(),
  confidence: z.number().optional(),
});

export const candidatePatchSchema = z.object({
  id: z.string(),
  rung: z.number().int().min(0).max(4),
  temperature: z.number().min(0).max(1),
  hypothesis: z.string(),
  diff: z.string(),
  filesTouched: z.array(z.string()),
  syntaxValid: z.boolean(),
  diagnosticsDelta: z.number().int(),
});

export const candidateEvaluationSchema = z.object({
  candidateId: z.string(),
  clean: z.boolean(),
  newFailuresCount: z.number().int().nonnegative(),
  reproPassed: z.boolean(),
  extraCasesFailed: z.number().int().nonnegative(),
  literalLeaksCount: z.number().int().nonnegative(),
  clusterSize: z.number().int().positive(),
  diffLines: z.number().int().nonnegative(),
  filesTouched: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
});

export const fsmContextSchema = z.object({
  runId: z.string(),
  repoRoot: z.string(),
  baseSha: z.string(),
  inputHash: z.string(),
  issue: z.object({
    id: z.string(),
    title: z.string().optional(),
    problemStatement: z.string(),
  }),
  state: fsmStateSchema,
  transitionsCount: z.number().int().nonnegative(),
  visits: z.record(fsmStateSchema, z.number().int().nonnegative()),
  history: z.array(transitionRecordSchema),
  rung: z.number().int().min(0).max(4),
  localization: z
    .object({
      files: z.array(z.string()),
      spans: z.array(fileSpanSchema),
      confidence: z.number(),
      exploredViaA4: z.boolean().optional(),
    })
    .optional(),
  specification: z
    .object({
      intent: z
        .object({
          rootCause: z.string(),
          fixStrategy: z.string(),
          edgeCases: z.array(z.string()),
        })
        .optional(),
      repro: z
        .object({
          path: z.string(),
          code: z.string(),
          sha256: z.string(),
          admitted: z.boolean(),
          baselineFailCount: z.number().int(),
        })
        .optional(),
      reproStatus: z.enum(['reproduced', 'unavailable', 'untested']),
    })
    .optional(),
  candidates: z.array(candidatePatchSchema),
  evaluations: z.array(candidateEvaluationSchema),
  bestCandidateId: z.string().optional(),
  evidence: z.custom<EvidenceBundle>().optional(),
  tombstones: z.array(z.string()),
  error: z.string().optional(),
});

/**
 * Creates a fresh, initial FsmContext at the INTAKE state.
 */
export function createInitialFsmContext(params: {
  runId: string;
  repoRoot: string;
  baseSha: string;
  inputHash: string;
  issue: { id: string; title?: string; problemStatement: string };
}): FsmContext {
  const initialVisits: Record<FsmState, number> = {
    INTAKE: 1,
    A_LOCALIZE: 0,
    B_SPECIFY: 0,
    C_SYNTHESIZE: 0,
    D_VERIFY: 0,
    E_SELECT: 0,
    F_FINALIZE: 0,
    DONE_VERIFIED: 0,
    DONE_UNVERIFIED: 0,
    DONE_NO_PATCH: 0,
    ABORT_ENV: 0,
    ABORT_BUDGET: 0,
  };

  return {
    runId: params.runId,
    repoRoot: params.repoRoot,
    baseSha: params.baseSha,
    inputHash: params.inputHash,
    issue: params.issue,
    state: 'INTAKE',
    transitionsCount: 0,
    visits: initialVisits,
    history: [],
    rung: 0,
    candidates: [],
    evaluations: [],
    tombstones: [],
  };
}

/**
 * Checks if the target state has exceeded its visit cap or if the global transition limit is hit.
 */
export function checkCapViolation(
  ctx: FsmContext,
  targetState: FsmState,
  caps: Record<ActiveFsmState, number> = DEFAULT_STATE_VISIT_CAPS,
): { violated: boolean; reason?: string } {
  if (ctx.transitionsCount >= MAX_TRANSITIONS) {
    return {
      violated: true,
      reason: `Global transition limit (${MAX_TRANSITIONS}) reached.`,
    };
  }

  if (targetState in caps) {
    const activeTarget = targetState as ActiveFsmState;
    const currentVisits = ctx.visits[activeTarget];
    const maxAllowed = caps[activeTarget];
    if (currentVisits >= maxAllowed) {
      return {
        violated: true,
        reason: `Visit cap for state ${activeTarget} (${maxAllowed}) exceeded.`,
      };
    }
  }

  return { violated: false };
}
