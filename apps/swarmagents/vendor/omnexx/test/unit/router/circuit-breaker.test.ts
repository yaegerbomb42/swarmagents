import { describe, expect, it, beforeEach } from 'vitest';
import {
  CascadeCircuitBreaker,
  MAX_CALLS_PER_TIER,
  ESCALATION_TRIGGERS,
  type EscalationTrigger,
} from '../../../src/router/circuit-breaker.js';

let breaker: CascadeCircuitBreaker;

beforeEach(() => {
  breaker = new CascadeCircuitBreaker();
});

describe('CascadeCircuitBreaker: budget escalation', () => {
  it('does not escalate before the failure budget is exhausted', () => {
    breaker.recordFailure('t1', 2, 'some error');
    const decision = breaker.shouldEscalate('t1', 2);
    expect(decision.escalate).toBe(false);
    expect(decision.targetTier).toBe(2);
  });

  it('escalates tier 2 → tier 3 after MAX_CALLS_PER_TIER consecutive failures', () => {
    for (let i = 0; i < MAX_CALLS_PER_TIER; i++) {
      breaker.recordFailure('t1', 2, `attempt ${String(i + 1)} failed`);
    }
    const decision = breaker.shouldEscalate('t1', 2);
    expect(decision.escalate).toBe(true);
    expect(decision.targetTier).toBe(3);
    expect(decision.reason).toContain(String(MAX_CALLS_PER_TIER));
    expect(decision.reason).toContain('consecutive failures');
  });

  it('resets the failure counter on success', () => {
    breaker.recordFailure('t1', 2, 'fail 1');
    breaker.recordSuccess('t1', 2);
    breaker.recordFailure('t1', 2, 'fail 2');
    const decision = breaker.shouldEscalate('t1', 2);
    expect(decision.escalate).toBe(false);
  });

  it('uses MAX_CALLS_PER_TIER = 2', () => {
    expect(MAX_CALLS_PER_TIER).toBe(2);
  });
});

describe('CascadeCircuitBreaker: tier 1 immediate escalation', () => {
  it('escalates tier 1 → tier 2 on any failure (deterministic path cannot retry)', () => {
    breaker.recordFailure('t1', 1, 'file not found');
    const decision = breaker.shouldEscalate('t1', 1);
    expect(decision.escalate).toBe(true);
    expect(decision.targetTier).toBe(2);
    expect(decision.reason).toMatch(/tier 1 failure|deterministic/);
  });

  it('escalates tier 1 → tier 2 on a syntax error trigger', () => {
    breaker.recordFailure('t1', 1, 'SyntaxError: unexpected token');
    const decision = breaker.shouldEscalate('t1', 1);
    expect(decision.escalate).toBe(true);
    expect(decision.targetTier).toBe(2);
    expect(decision.reason).toContain('SYNTAX_ERROR');
  });

  it('escalates tier 1 → tier 2 on a path error', () => {
    breaker.recordFailure('t1', 1, 'outside the worktree');
    const decision = breaker.shouldEscalate('t1', 1);
    expect(decision.escalate).toBe(true);
    expect(decision.targetTier).toBe(2);
  });
});

describe('CascadeCircuitBreaker: immediate escalation triggers', () => {
  it.each<[EscalationTrigger, string]>([
    ['SYNTAX_ERROR', 'SyntaxError: unexpected token in a.ts'],
    ['SYNTAX_ERROR', 'preflight AST gate rejected the edit'],
    ['TEST_REGRESSION', 'test regression: 3 new failures detected'],
    ['TEST_REGRESSION', 'test fail in suite runner'],
    ['PARSE_FAILURE', 'parse_failure: malformed tool output'],
    ['PARSE_FAILURE', 'model output violates tool schema'],
    ['ITERATION_EXCEEDED', 'iteration exceeded: 12 turns used of 8 budget'],
    ['ITERATION_EXCEEDED', 'turn budget exhausted after 10 turns'],
  ])('trigger %s fires on error %j and escalates tier 2 → 3', (trigger, error) => {
    breaker.recordFailure('t1', 2, error);
    const decision = breaker.shouldEscalate('t1', 2);
    expect(decision.escalate).toBe(true);
    expect(decision.targetTier).toBe(3);
    expect(decision.reason).toContain(trigger);
  });

  it('exports all four documented trigger constants', () => {
    expect([...ESCALATION_TRIGGERS]).toEqual([
      'SYNTAX_ERROR',
      'TEST_REGRESSION',
      'PARSE_FAILURE',
      'ITERATION_EXCEEDED',
    ]);
  });
});

describe('CascadeCircuitBreaker: tier 3 terminal', () => {
  it('never escalates from tier 3', () => {
    for (let i = 0; i < 10; i++) {
      breaker.recordFailure('t1', 3, `attempt ${String(i)}`);
    }
    const decision = breaker.shouldEscalate('t1', 3);
    expect(decision.escalate).toBe(false);
    expect(decision.targetTier).toBe(3);
  });

  it('produces structured triage output when tier 3 fails', () => {
    breaker.recordFailure('t1', 1, 'file missing');
    breaker.recordFailure('t1', 2, 'TS2322 type mismatch');
    breaker.recordFailure('t1', 2, 'SyntaxError in output');
    breaker.recordFailure('t1', 3, 'still broken after frontier reasoning');

    const blocked = breaker.getBlockedResult('t1');
    expect(blocked).toBeDefined();
    expect(blocked?.blocked).toBe(true);
    expect(blocked?.taskId).toBe('t1');
    expect(blocked?.tier).toBe(3);
    expect(blocked?.failedAttempts).toBe(1);
    expect(blocked?.diagnosticCodes).toContain('TS2322');
    expect(blocked?.diagnosticCodes).toContain('SyntaxError');
    expect(blocked?.triage).toContain('BLOCKED');
    expect(blocked?.triage).toContain('still broken');
    expect(blocked?.triage).toContain('SYNTAX_ERROR');
    expect(blocked?.triage).toContain('human intervention');
  });

  it('returns undefined when tier 3 has not failed', () => {
    breaker.recordFailure('t1', 2, 'some error');
    expect(breaker.getBlockedResult('t1')).toBeUndefined();
  });
});

describe('CascadeCircuitBreaker: failure context', () => {
  it('tracks per-tier failure context with diagnostic codes', () => {
    breaker.recordFailure('t1', 2, 'TS2322 Type string not assignable to number');
    breaker.recordFailure('t1', 2, 'E0308 mismatched types');

    const ctx = breaker.getFailureContext('t1', 2);
    expect(ctx.tier).toBe(2);
    expect(ctx.failedAttempts).toBe(2);
    expect(ctx.lastError).toContain('E0308');
    expect(ctx.diagnosticCodes).toContain('TS2322');
    expect(ctx.diagnosticCodes).toContain('E0308');
  });

  it('returns zero failures for an unknown task', () => {
    const ctx = breaker.getFailureContext('unknown', 2);
    expect(ctx.failedAttempts).toBe(0);
    expect(ctx.lastError).toBeUndefined();
    expect(ctx.diagnosticCodes).toBeUndefined();
  });
});

describe('CascadeCircuitBreaker: reset and isolation', () => {
  it('reset clears all state for a task', () => {
    breaker.recordFailure('t1', 2, 'error 1');
    breaker.recordFailure('t1', 2, 'error 2');
    breaker.reset('t1');

    const decision = breaker.shouldEscalate('t1', 2);
    expect(decision.escalate).toBe(false);
    expect(breaker.getFailureContext('t1', 2).failedAttempts).toBe(0);
    expect(breaker.getBlockedResult('t1')).toBeUndefined();
  });

  it('tracks tasks independently', () => {
    breaker.recordFailure('t1', 2, 'fail');
    breaker.recordFailure('t1', 2, 'fail');
    breaker.recordFailure('t2', 2, 'fail');

    expect(breaker.shouldEscalate('t1', 2).escalate).toBe(true);
    expect(breaker.shouldEscalate('t2', 2).escalate).toBe(false);
  });

  it('exposes the number of tracked tasks via size', () => {
    expect(breaker.size).toBe(0);
    breaker.recordFailure('t1', 1);
    breaker.recordFailure('t2', 2);
    expect(breaker.size).toBe(2);
    breaker.reset('t1');
    expect(breaker.size).toBe(1);
  });
});

describe('CascadeCircuitBreaker: full escalation cascade', () => {
  it('walks tier 1 → 2 → 3 → blocked across successive failures', () => {
    // Tier 1 fails once → escalate to 2
    breaker.recordFailure('task-x', 1, 'file not found');
    const d1 = breaker.shouldEscalate('task-x', 1);
    expect(d1.escalate).toBe(true);
    expect(d1.targetTier).toBe(2);

    // Tier 2 fails twice → escalate to 3
    breaker.recordFailure('task-x', 2, 'TS2322 wrong type');
    expect(breaker.shouldEscalate('task-x', 2).escalate).toBe(false);
    breaker.recordFailure('task-x', 2, 'TS2322 still wrong');
    const d2 = breaker.shouldEscalate('task-x', 2);
    expect(d2.escalate).toBe(true);
    expect(d2.targetTier).toBe(3);

    // Tier 3 fails → blocked
    breaker.recordFailure('task-x', 3, 'frontier could not resolve');
    const d3 = breaker.shouldEscalate('task-x', 3);
    expect(d3.escalate).toBe(false);

    const blocked = breaker.getBlockedResult('task-x');
    expect(blocked).toBeDefined();
    expect(blocked?.blocked).toBe(true);
    expect(blocked?.triage).toContain('BLOCKED');
    expect(blocked?.diagnosticCodes).toContain('TS2322');
  });
});
