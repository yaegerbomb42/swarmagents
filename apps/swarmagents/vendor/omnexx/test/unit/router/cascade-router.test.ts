import { describe, expect, it } from 'vitest';
import {
  LARGE_CONTEXT_TOKENS,
  MAX_CALLS_PER_TIER,
  routeTask,
  TIER_MODELS,
  type CascadeRoute,
} from '../../../src/router/cascade-router.js';

const route = (prompt: string, contextTokens = 1_000): CascadeRoute =>
  routeTask(prompt, contextTokens);

describe('routeTask: tier 1 deterministic fast path', () => {
  it.each([
    'read src/index.ts',
    'show me the contents of package.json',
    'list files in src/',
    'ls the test directory',
    'find files matching *.test.ts',
    'grep for routeTask',
    'rg "formatSource" src/',
    'show anchors for src/router/router.ts',
    'anchors src/verify/preflight.ts',
    'git status',
    'git log --oneline -5',
    'git diff main',
    'npm run lint',
    'run npm run typecheck',
    'run prettier --check src/',
    'gofmt -l .',
    'ruff check src/',
    'format src/verify/formatters.ts',
  ])('routes %j to tier 1', (prompt) => {
    const result = route(prompt);
    expect(result.tier).toBe(1);
    expect(result.modelSuggested).toBe(TIER_MODELS[1]);
    expect(result.reason).toMatch(/tier 1/);
    expect(result.reason).toMatch(/no model/i);
  });

  it('keeps read-only reconnaissance on tier 1 even with a large context', () => {
    expect(route('read the repository map', LARGE_CONTEXT_TOKENS * 2).tier).toBe(1);
  });

  it('does not take the fast path when the prompt also asks for a mutation', () => {
    expect(route('read src/auth.ts and fix the login bug').tier).not.toBe(1);
  });
});

describe('routeTask: tier 2 fast/cheap model', () => {
  it.each([
    'fix the null pointer in parseConfig',
    'rename the variable timeoutMs to budgetMs in src/config.ts',
    'parse the vitest output and update the failing assertion',
    'write a unit test for the formatter dispatcher',
    'fix a single-file typo in the README',
    'adjust this function to return early',
    'implement a small CLI flag for verbose logging',
    'debug this stack trace in src/tools/edit.ts',
  ])('routes %j to tier 2', (prompt) => {
    const result = route(prompt);
    expect(result.tier).toBe(2);
    expect(result.modelSuggested).toBe(TIER_MODELS[2]);
    expect(result.reason).toMatch(/tier 2/);
  });
});

describe('routeTask: tier 3 frontier model', () => {
  it.each([
    'design a new architecture for the plugin system',
    'explain the architecture of the codebase',
    'perform a complex architectural synthesis across services',
    'refactor the auth module across the entire codebase',
    'cross-module refactor of the billing package',
    'implement OAuth2 JWT authentication for the API',
    'harden the security layer and add encryption at rest',
    'migrate the database schema to support multi-tenancy',
    'fix the race condition in the distributed scheduler',
    'run a differential TDR root cause analysis on the regression',
    'optimize the latency of the whole codebase pipeline',
    'update src/a.ts src/b.ts src/c.ts and src/d.ts',
  ])('routes %j to tier 3', (prompt) => {
    const result = route(prompt);
    expect(result.tier).toBe(3);
    expect(result.modelSuggested).toBe(TIER_MODELS[3]);
    expect(result.reason).toMatch(/tier 3/);
  });

  it('escalates a routine task when the context alone exceeds the tier-2 budget', () => {
    const result = route('apply the pending patch', LARGE_CONTEXT_TOKENS);
    expect(result.tier).toBe(3);
    expect(result.reason).toMatch(/large context/);
  });

  it('does not escalate a small context', () => {
    expect(route('apply the pending patch', LARGE_CONTEXT_TOKENS - 1).tier).toBe(2);
  });
});

describe('routeTask: determinism and contract', () => {
  it('is a pure, synchronous O(1) decision with no model call', () => {
    expect(typeof routeTask('read a file', 10)).toBe('object');
    expect(routeTask('read a file', 10)).toEqual(routeTask('read a file', 10));
  });

  it('handles empty, malformed, and non-finite inputs without throwing', () => {
    expect(route('').tier).toBe(2);
    expect(routeTask('fix bug', Number.NaN).tier).toBe(2);
    expect(routeTask('fix bug', -100).tier).toBe(2);
    expect(routeTask(undefined as unknown as string, 10).tier).toBe(2);
  });

  it('exposes the circuit-breaker budget from Phase 4.4', () => {
    expect(MAX_CALLS_PER_TIER).toBe(2);
  });

  it('always fills modelSuggested and reason', () => {
    for (const prompt of ['read a.ts', 'fix a bug', 'redesign the distributed system']) {
      const result = route(prompt);
      expect(result.modelSuggested.length).toBeGreaterThan(0);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
