import { z } from 'zod';

/**
 * A verified fact bound to a specific file hash.
 * If the file hash on disk changes, the fact automatically expires.
 */
export const factSchema = z.object({
  id: z.string(),
  file: z.string(),
  fileHash: z.string(),
  statement: z.string(),
  symbol: z.string().optional(),
  timestamp: z.number(),
});
export type Fact = z.infer<typeof factSchema>;

/**
 * An anti-pattern or failed approach recorded to avoid looping.
 */
export const failedAttemptSchema = z.object({
  id: z.string(),
  target: z.string(),
  approach: z.string(),
  error: z.string(),
  timestamp: z.number(),
});
export type FailedAttempt = z.infer<typeof failedAttemptSchema>;

/**
 * Test evidence cryptographically bound to a diff hash.
 */
export const testEvidenceSchema = z.object({
  command: z.string(),
  passed: z.boolean(),
  exitCode: z.number(),
  diffHash: z.string(),
  outputSnippet: z.string(),
  timestamp: z.number(),
});
export type TestEvidence = z.infer<typeof testEvidenceSchema>;

/**
 * A completed milestone or sub-problem with bound evidence.
 */
export const doneItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  evidence: testEvidenceSchema,
});
export type DoneItem = z.infer<typeof doneItemSchema>;

/**
 * Typed memory state file representation:
 * Built fresh each call, replaces unbounded transcript history.
 */
export const scopeStateSchema = z.object({
  goal: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
  plan: z.array(z.string()).default([]),
  doneItems: z.array(doneItemSchema).default([]),
  nextAction: z.string().default(''),
  depth: z.number().int().min(0).default(0),
});
export type ScopeState = z.infer<typeof scopeStateSchema>;

/**
 * Budget curve calculation:
 * Depth 0 (root): 32,000 tokens
 * Depth 1 (child): 12,000 tokens
 * Depth 2 (leaf): 6,000 tokens
 * Depth 3+: 4,000 tokens
 */
export function defaultBudgetCurve(depth: number, baseBudget = 32_000): number {
  if (depth <= 0) return baseBudget;
  if (depth === 1) return Math.min(baseBudget, 12_000);
  if (depth === 2) return Math.min(baseBudget, 6_000);
  return Math.min(baseBudget, 4_000);
}

/**
 * Compact Return Contract for child scopes.
 * Context is discarded when the child completes; parent only receives this contract.
 */
export const returnContractSchema = z.object({
  scopeId: z.string(),
  status: z.enum(['solved', 'failed', 'partial']),
  diff: z.string(),
  diffHash: z.string(),
  facts: z.array(factSchema).default([]),
  evidence: testEvidenceSchema.optional(),
  error: z.string().optional(),
});
export type ReturnContract = z.infer<typeof returnContractSchema>;

/**
 * Input for independent verifier scope.
 * Sees ONLY the diff, acceptance criteria, and test output.
 */
export interface VerifierInput {
  diff: string;
  diffHash: string;
  acceptanceCriteria: string[];
  testOutput: string;
  exitCode: number;
}

export interface VerifierResult {
  verified: boolean;
  diffHash: string;
  reason: string;
  timestamp: number;
}

/**
 * Request to instantiate a child scope.
 */
export interface ChildScopeRequest {
  id: string;
  subGoal: string;
  budget: number;
  inheritedRules: string[];
  relevantFacts: Fact[];
  targetFiles: string[];
  targetSymbols?: string[] | undefined;
  acceptanceCriteria: string[];
  depth: number;
}

/**
 * Node in the scope tree.
 */
export interface ScopeNode {
  id: string;
  parentId?: string | undefined;
  goal: string;
  budget: number;
  depth: number;
  plan: string[];
  children: ScopeNode[];
  state: ScopeState;
  result?: ReturnContract | undefined;
}

/**
 * Telemetry log entry for performance comparison.
 */
export interface ScopeTelemetryTurn {
  scopeId: string;
  depth: number;
  turn: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  filesRead: string[];
  isReRead: boolean;
  timestamp: number;
}

export interface ScopeTelemetryReport {
  mode: 'recursive' | 'baseline';
  taskId: string;
  solved: boolean;
  totalTokens: number;
  totalTurns: number;
  tokensPerTurn: number[];
  wallTimeMs: number;
  reReadRatio: number;
  turns: ScopeTelemetryTurn[];
}
