import type { Candidate } from './candidates.js';
import type { Role, RouteAction } from './actions.js';

export type TaskStage = 'exploration' | 'architecture' | 'verification';

export interface StagePolicy {
  stage: TaskStage;
  tier: 'fast-low-cost' | 'high-reasoning';
  preferredRole: Role;
  targetQuality: 'low' | 'mid' | 'high';
  description: string;
}

export const STAGE_POLICIES: Record<TaskStage, StagePolicy> = {
  exploration: {
    stage: 'exploration',
    tier: 'fast-low-cost',
    preferredRole: 'cheap',
    targetQuality: 'low',
    description:
      'Fast / Low-Cost for grepping, listing directories, reading ASTs (Gemini Flash, Claude Haiku, Qwen 2.5 14B)',
  },
  architecture: {
    stage: 'architecture',
    tier: 'high-reasoning',
    preferredRole: 'planner',
    targetQuality: 'high',
    description:
      'High-Reasoning for designing patches, complex refactoring (Claude Sonnet 3.7 / Opus, DeepSeek-R1, GPT-4o)',
  },
  verification: {
    stage: 'verification',
    tier: 'fast-low-cost',
    preferredRole: 'cheap',
    targetQuality: 'low',
    description: 'Fast / Low-Cost for test suite runs and lint triage (Local Ollama, small models)',
  },
};

/**
 * Maps a route action to its task execution stage.
 */
export function stageForAction(action: RouteAction): TaskStage {
  switch (action) {
    case 'read-explore':
    case 'docs':
    case 'summarize':
    case 'compact':
    case 'browser-step':
    case 'commit-message':
      return 'exploration';

    case 'plan':
    case 'replan':
    case 'split':
    case 'refactor':
    case 'edit-large':
    case 'debug-failure':
    case 'intent-infer':
    case 'beyond-ideate':
    case 'review-diff':
      return 'architecture';

    case 'write-tests':
    case 'edit-small':
      return 'verification';
  }
}

/**
 * Ranks model candidates based on the stage's recommended tier.
 * - Architecture: prefers high-reasoning models (high quality, Sonnet/Opus/R1/GPT-4o).
 * - Exploration & Verification: prefers fast, cost-efficient models (low quality / fast speed, Flash/Haiku/Ollama/Qwen).
 */
export function rankCandidatesForStage(
  candidates: readonly Candidate[],
  stage: TaskStage,
): Candidate[] {
  const policy = STAGE_POLICIES[stage];
  const list = [...candidates];

  list.sort((a, b) => {
    if (policy.tier === 'high-reasoning') {
      const qScore = (c: Candidate): number =>
        c.quality === 'high' ? 3 : c.quality === 'mid' ? 2 : 1;
      return qScore(b) - qScore(a);
    }
    // fast-low-cost tier: prefer fast speed, then cheap role, then low quality
    const sScore = (c: Candidate): number => {
      let score = 0;
      if (c.speed === 'fast') score += 4;
      if (c.roles.includes(policy.preferredRole)) score += 2;
      if (c.quality === 'low') score += 1;
      return score;
    };
    return sScore(b) - sScore(a);
  });

  return list;
}

export interface ComplexityContext {
  prompt?: string;
  filesChanged?: number | string[];
  isArchitecture?: boolean;
  hasAuthOrDb?: boolean;
  priorTestFailures?: boolean;
  tokenCount?: number;
}

export interface ComplexityScore {
  tier: 1 | 2 | 3;
  score: number;
  reasons: string[];
}

const AUTH_DB_REGEX =
  /\b(?:auth|jwt|token|login|credential|password|session|oauth|db|database|migration|schema|sql|postgres|sqlite|prisma|typeorm)\b/i;
const ARCH_REGEX =
  /\b(?:architecture|refactor|migration|redesign|restructure|subsystem|boundary|breaking)\b/i;
const RECON_REGEX = /^\s*(?:read|cat|view|ls|list|dir|find|grep|rg|status|diff|check)\b/i;

/**
 * Step 4.3: Semantic Complexity Scoring & Stage Policies.
 *
 * Fast classification into 3 tiers:
 * - Tier 3 (Frontier): Multi-file tasks (>3 files), architectural changes, auth/db layers, prior test failures, or >100k tokens.
 * - Tier 2 (Mid-tier): Single-module unit test authoring, localized fixes with stack traces.
 * - Tier 1 (Deterministic/Recon): Read-only reconnaissance, listings, static syntax/format checks.
 */
export function scoreComplexity(ctx: ComplexityContext): ComplexityScore {
  const reasons: string[] = [];
  let score = 0;

  // 1. Context window ceiling
  if (ctx.tokenCount && ctx.tokenCount >= 100_000) {
    score += 5;
    reasons.push('Context window exceeds 100k tokens');
  }

  // 2. Multi-file scope
  const fileCount = Array.isArray(ctx.filesChanged)
    ? ctx.filesChanged.length
    : (ctx.filesChanged ?? 0);
  if (fileCount > 3) {
    score += 4;
    reasons.push(`Multi-file task (${String(fileCount)} files > 3)`);
  }

  // 3. Critical auth / DB layers
  const text = ctx.prompt ?? '';
  if (ctx.hasAuthOrDb || AUTH_DB_REGEX.test(text)) {
    score += 4;
    reasons.push('Touches critical auth, database, security, or migration layers');
  }

  // 4. Architectural refactors
  if (ctx.isArchitecture || ARCH_REGEX.test(text)) {
    score += 3;
    reasons.push('Architectural or cross-module restructuring');
  }

  // 5. Prior test failures requiring deep root-cause diagnosis
  if (ctx.priorTestFailures) {
    score += 3;
    reasons.push('Prior test regression requires frontier root-cause diagnosis');
  }

  // Tier 3 threshold
  if (score >= 3) {
    return { tier: 3, score, reasons };
  }

  // Recon / Tier 1 checks
  if (RECON_REGEX.test(text) && fileCount === 0 && !ctx.priorTestFailures) {
    return { tier: 1, score: 0, reasons: ['Deterministic reconnaissance / read-only query'] };
  }

  // Mid-tier default for localized work
  return {
    tier: 2,
    score: Math.max(1, score),
    reasons: reasons.length > 0 ? reasons : ['Localized single-module edit or test update'],
  };
}
