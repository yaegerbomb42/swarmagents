import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../../src/router/candidates.js';
import {
  rankCandidatesForStage,
  STAGE_POLICIES,
  stageForAction,
} from '../../../src/router/stage.js';

describe('stageForAction', () => {
  it('maps exploration actions to exploration stage', () => {
    expect(stageForAction('read-explore')).toBe('exploration');
    expect(stageForAction('docs')).toBe('exploration');
    expect(stageForAction('summarize')).toBe('exploration');
    expect(stageForAction('compact')).toBe('exploration');
    expect(stageForAction('browser-step')).toBe('exploration');
  });

  it('maps architecture & complex refactoring to architecture stage', () => {
    expect(stageForAction('plan')).toBe('architecture');
    expect(stageForAction('replan')).toBe('architecture');
    expect(stageForAction('split')).toBe('architecture');
    expect(stageForAction('refactor')).toBe('architecture');
    expect(stageForAction('edit-large')).toBe('architecture');
    expect(stageForAction('debug-failure')).toBe('architecture');
  });

  it('maps test and lint verification to verification stage', () => {
    expect(stageForAction('write-tests')).toBe('verification');
    expect(stageForAction('edit-small')).toBe('verification');
  });
});

describe('STAGE_POLICIES', () => {
  it('defines recommended tiers matching the strategy matrix', () => {
    expect(STAGE_POLICIES.exploration.tier).toBe('fast-low-cost');
    expect(STAGE_POLICIES.exploration.preferredRole).toBe('cheap');

    expect(STAGE_POLICIES.architecture.tier).toBe('high-reasoning');
    expect(STAGE_POLICIES.architecture.preferredRole).toBe('planner');

    expect(STAGE_POLICIES.verification.tier).toBe('fast-low-cost');
    expect(STAGE_POLICIES.verification.preferredRole).toBe('cheap');
  });
});

describe('rankCandidatesForStage', () => {
  const mockCandidate = (
    ref: string,
    quality: Candidate['quality'],
    speed: Candidate['speed'],
    roles: Candidate['roles'],
  ): Candidate => {
    const [provider = 'anthropic', id = 'model'] = ref.split(':');
    return {
      ref,
      model: {
        provider,
        id,
        alias: id,
        price: {
          id,
          input: 1,
          output: 2,
          cache_write_5m: 1,
          cache_write_1h: 1,
          cache_read: 0.1,
        },
      },
      roles,
      profile: {
        tags: [],
        tools: true,
        vision: false,
        quality,
        speed,
      },
      quality,
      speed,
    };
  };

  const highReasoningCandidate = mockCandidate('anthropic:claude-3-7-sonnet', 'high', 'normal', [
    'planner',
  ]);
  const fastLowCostCandidate = mockCandidate('google:gemini-2.0-flash', 'low', 'fast', ['cheap']);

  const candidates: Candidate[] = [highReasoningCandidate, fastLowCostCandidate];

  it('prioritizes high-reasoning models for architecture stage', () => {
    const ranked = rankCandidatesForStage(candidates, 'architecture');
    expect(ranked[0]?.ref).toBe('anthropic:claude-3-7-sonnet');
    expect(ranked[1]?.ref).toBe('google:gemini-2.0-flash');
  });

  it('prioritizes fast/low-cost models for exploration stage', () => {
    const ranked = rankCandidatesForStage(candidates, 'exploration');
    expect(ranked[0]?.ref).toBe('google:gemini-2.0-flash');
    expect(ranked[1]?.ref).toBe('anthropic:claude-3-7-sonnet');
  });

  it('prioritizes fast/low-cost models for verification stage', () => {
    const ranked = rankCandidatesForStage(candidates, 'verification');
    expect(ranked[0]?.ref).toBe('google:gemini-2.0-flash');
    expect(ranked[1]?.ref).toBe('anthropic:claude-3-7-sonnet');
  });
});

describe('Step 4.3: scoreComplexity', () => {
  it('routes multi-file tasks (>3 files) to Tier 3', async () => {
    const { scoreComplexity } = await import('../../../src/router/stage.js');
    const result = scoreComplexity({ filesChanged: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] });
    expect(result.tier).toBe(3);
    expect(result.reasons.some((r) => r.includes('Multi-file task'))).toBe(true);
  });

  it('routes auth, token, and database mutations to Tier 3', async () => {
    const { scoreComplexity } = await import('../../../src/router/stage.js');
    const result = scoreComplexity({ prompt: 'Fix jwt authentication refresh token issue' });
    expect(result.tier).toBe(3);
    expect(result.reasons.some((r) => r.includes('auth'))).toBe(true);
  });

  it('routes tasks with >100k tokens to Tier 3', async () => {
    const { scoreComplexity } = await import('../../../src/router/stage.js');
    const result = scoreComplexity({ tokenCount: 120_000 });
    expect(result.tier).toBe(3);
    expect(result.reasons.some((r) => r.includes('100k tokens'))).toBe(true);
  });

  it('routes prior test failure regressions to Tier 3', async () => {
    const { scoreComplexity } = await import('../../../src/router/stage.js');
    const result = scoreComplexity({ priorTestFailures: true });
    expect(result.tier).toBe(3);
    expect(result.reasons.some((r) => r.includes('test regression'))).toBe(true);
  });

  it('routes localized single-module edits to Tier 2', async () => {
    const { scoreComplexity } = await import('../../../src/router/stage.js');
    const result = scoreComplexity({ prompt: 'Add a helper to format numbers', filesChanged: 1 });
    expect(result.tier).toBe(2);
  });

  it('routes deterministic reconnaissance and reads to Tier 1', async () => {
    const { scoreComplexity } = await import('../../../src/router/stage.js');
    const result = scoreComplexity({ prompt: 'grep for function definition in src/' });
    expect(result.tier).toBe(1);
  });
});

describe('Step 4.2: pruneToolsForTier', () => {
  it('prunes tool schemas for Tier 1 to only reconnaissance tools', async () => {
    const { pruneToolsForTier } = await import('../../../src/router/router.js');
    const tools = [
      { name: 'read_file', description: 'read', inputSchema: {} },
      { name: 'grep', description: 'search', inputSchema: {} },
      { name: 'edit', description: 'mutate file', inputSchema: {} },
      { name: 'bash', description: 'execute shell', inputSchema: {} },
    ];

    const prunedTier1 = pruneToolsForTier(tools, 1);
    expect(prunedTier1.map((t) => t.name)).toEqual(['read_file', 'grep']);

    const tier2 = pruneToolsForTier(tools, 2);
    expect(tier2.length).toBe(4);

    const tier3 = pruneToolsForTier(tools, 3);
    expect(tier3.length).toBe(4);
  });
});
