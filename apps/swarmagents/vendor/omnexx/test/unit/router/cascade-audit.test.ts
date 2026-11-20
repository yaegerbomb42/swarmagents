import { describe, expect, it } from 'vitest';
import {
  LARGE_CONTEXT_TOKENS,
  routeTask,
  TIER_MODELS,
  type CascadeRoute,
} from '../../../src/router/cascade-router.js';
import { ROUTE_ACTIONS } from '../../../src/router/actions.js';
import { stageForAction } from '../../../src/router/stage.js';

const route = (prompt: string, contextTokens = 1_000): CascadeRoute =>
  routeTask(prompt, contextTokens);

/**
 * Subsystem 5 audit — Model Routing, Cascade Classifier & Fast-Path Engine.
 *
 * Every claim below is supported by a reproducing unit test (the check mandates
 * "no audit claim without a reproducing Vitest test").
 */

describe('S5 audit: fast-path false positives (mutating intents never Tier 1)', () => {
  // Each prompt *starts* with a read verb so it satisfies the Tier-1 read shape,
  // but also carries a mutating intent. A read-only fast-path classification would
  // be a false positive.
  const MUTATING_PROMPTS: readonly { prompt: string; intent: string }[] = [
    { prompt: 'read src/auth.ts and edit the login flow', intent: 'edit' },
    { prompt: 'open config.json and write a new key', intent: 'write' },
    { prompt: 'read the manifest and rm the stale entry', intent: 'rm' },
    { prompt: 'show package.json and delete the deprecated field', intent: 'delete' },
    { prompt: 'read src/settings.ts and replace the timeout value', intent: 'replace' },
    { prompt: 'cat src/util.ts and fix the typo', intent: 'fix' },
  ];

  it.each(MUTATING_PROMPTS)(
    'never routes a read-shaped prompt that also mutates ($intent) to Tier 1',
    ({ prompt }) => {
      const result = route(prompt);
      expect(result.tier, `${prompt} must not be a Tier-1 fast path`).not.toBe(1);
      expect(result.reason).not.toMatch(/tier 1/);
    },
  );

  // The other deterministic branches (git query, static check, format, anchors)
  // must also refuse to shortcut a prompt that carries a mutation.
  it.each([
    'git status then delete the stale branch',
    'run npm typecheck and fix the errors',
    'format src/ and replace all tabs with spaces',
    'show anchors for src/router/router.ts then edit the router',
  ])('keeps %j off the Tier-1 fast path when it also mutates', (prompt) => {
    const result = route(prompt);
    expect(result.tier).not.toBe(1);
    expect(result.reason).not.toMatch(/tier 1/);
  });

  it('still routes a pure read-only request to Tier 1 (positive control)', () => {
    for (const prompt of [
      'read src/index.ts',
      'git status',
      'run npm run typecheck',
      'format src/verify/formatters.ts',
      'show anchors for src/router/router.ts',
    ]) {
      const result = route(prompt);
      expect(result.tier).toBe(1);
      expect(result.modelSuggested).toBe(TIER_MODELS[1]);
    }
  });
});

describe('S5 audit: automatic Tier-3 escalation (large context / multi-file)', () => {
  it('escalates instantly when context tokens meet the 100k ceiling', () => {
    const result = route('apply the pending patch', LARGE_CONTEXT_TOKENS);
    expect(result.tier).toBe(3);
    expect(result.reason).toMatch(/large context/);
  });

  it('escalates when context tokens exceed 100k', () => {
    const result = route('apply the pending patch', LARGE_CONTEXT_TOKENS + 5_000);
    expect(result.tier).toBe(3);
    expect(result.modelSuggested).toBe(TIER_MODELS[3]);
  });

  it('does NOT escalate just below the 100k ceiling', () => {
    expect(route('apply the pending patch', LARGE_CONTEXT_TOKENS - 1).tier).toBe(2);
  });

  it('escalates when the task spans more than 3 distinct files', () => {
    const result = route('update a.ts b.ts c.ts d.ts');
    expect(result.tier).toBe(3);
    expect(result.reason).toMatch(/files/);
  });

  it('does NOT escalate at exactly 3 distinct files', () => {
    expect(route('update a.ts b.ts c.ts').tier).toBe(2);
  });

  it('escalates a small-context fix that touches >3 files', () => {
    expect(route('fix the bugs in a.ts, b.ts, c.ts, d.ts').tier).toBe(3);
  });
});

describe('S5 audit: O(1) synchronous, pure routing contract', () => {
  it('returns a synchronous, materialized route object (never a Promise)', () => {
    const result = route('read src/index.ts');
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.tier).toBe('number');
    expect(typeof result.modelSuggested).toBe('string');
    expect(typeof result.reason).toBe('string');
  });

  it('is pure: identical inputs yield identical outputs', () => {
    const a = route('fix the null pointer in parseConfig', 42_000);
    const b = route('fix the null pointer in parseConfig', 42_000);
    expect(a).toEqual(b);
  });

  it('executes in well under 1ms per call (no disk/network I/O)', () => {
    // Warm up JIT / regex compilation before measuring.
    for (let i = 0; i < 500; i++) {
      route('read src/index.ts', 1_000);
      route('refactor the auth module across the codebase', 200_000);
    }
    const N = 2_000;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      route('update a.ts b.ts c.ts d.ts', 150_000);
    }
    const elapsedMs = performance.now() - start;
    const perCallMs = elapsedMs / N;
    expect(perCallMs).toBeLessThan(1);
  });
});

describe('S5 audit: stage/action wiring stays consistent with the cascade', () => {
  it('every route action maps to a defined stage', () => {
    for (const action of ROUTE_ACTIONS) {
      expect(stageForAction(action), action).toBeDefined();
    }
  });

  it('mutating worker actions map to architecture/verification, never exploration', () => {
    for (const action of [
      'edit-small',
      'edit-large',
      'refactor',
      'write-tests',
      'debug-failure',
    ] as const) {
      expect(stageForAction(action), action).toMatch(/architecture|verification/);
    }
  });
});
