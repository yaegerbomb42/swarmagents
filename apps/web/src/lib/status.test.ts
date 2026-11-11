import { describe, expect, it } from 'vitest';
import {
  CANONICAL_STATUSES,
  isActiveStatus,
  statusEdgeStyle,
  statusMeta,
  toCanonical,
} from './status';

describe('toCanonical', () => {
  it.each([
    ['pending', 'queued'],
    ['assigned', 'queued'],
    ['decomposing', 'planning'],
    ['running', 'running'],
    ['executing', 'running'],
    ['busy', 'running'],
    ['working', 'running'],
    ['validating', 'validating'],
    ['cooldown', 'paused'],
    ['blocked', 'blocked'],
    ['completed', 'done'],
    ['merged', 'done'],
    ['passed', 'done'],
    ['error', 'failed'],
    ['missed', 'failed'],
    ['canceled', 'cancelled'],
    ['idle', 'offline'],
    ['offline', 'offline'],
  ])('%s -> %s', (raw, expected) => {
    expect(toCanonical(raw)).toBe(expected);
  });

  it('is case/space insensitive and defaults unknowns to offline', () => {
    expect(toCanonical('  RUNNING ')).toBe('running');
    expect(toCanonical('In Progress')).toBe('running');
    expect(toCanonical('???')).toBe('offline');
    expect(toCanonical(undefined)).toBe('offline');
    expect(toCanonical(null)).toBe('offline');
  });
});

describe('statusMeta', () => {
  it('has meta for every canonical state', () => {
    for (const s of CANONICAL_STATUSES) {
      const m = statusMeta(s);
      expect(m.status).toBe(s);
      expect(m.label).toBeTruthy();
      expect(m.colorVar).toMatch(/^var\(--/);
    }
  });

  it('only running/thinking/planning animate', () => {
    for (const s of CANONICAL_STATUSES) {
      expect(statusMeta(s).animate !== 'none').toBe(isActiveStatus(s));
    }
  });

  it('running and done have different colors', () => {
    expect(statusMeta('running').colorVar).not.toBe(statusMeta('done').colorVar);
  });

  it('accepts raw statuses', () => {
    expect(statusMeta('completed').status).toBe('done');
    expect(statusMeta('error').colorVar).toContain('--st-failed');
  });
});

describe('statusEdgeStyle', () => {
  it('animates only active edges', () => {
    expect(statusEdgeStyle('running').animated).toBe(true);
    expect(statusEdgeStyle('done').animated).toBe(false);
    expect(statusEdgeStyle('pending').animated).toBe(false);
  });
});
