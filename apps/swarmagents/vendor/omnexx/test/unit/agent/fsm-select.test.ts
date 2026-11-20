import { describe, expect, it } from 'vitest';
import { computeRankKey, selectBestCandidate } from '../../../src/agent/fsm/phases/select.js';
import {
  b9AxisChange,
  b10EarlyStopping,
  createBreakerState,
  detectLiteralLeaks,
  escalationRung,
} from '../../../src/agent/fsm/breakers.js';

describe('fsm select rankKey', () => {
  it('prefers clean over syntax error', () => {
    const a = {
      clean: false,
      newFailuresCount: 0,
      reproPassed: true,
      extraCasesFailed: 0,
      literalLeaksCount: 0,
      clusterSize: 1,
      diffLines: 1,
      filesTouched: 1,
      index: 0,
    };
    const b = {
      clean: true,
      newFailuresCount: 0,
      reproPassed: true,
      extraCasesFailed: 0,
      literalLeaksCount: 0,
      clusterSize: 1,
      diffLines: 1,
      filesTouched: 1,
      index: 1,
    };
    expect(selectBestCandidate([a, b])?.index).toBe(1);
  });

  it('prefers zero regression', () => {
    const a = {
      clean: true,
      newFailuresCount: 2,
      reproPassed: true,
      extraCasesFailed: 0,
      literalLeaksCount: 0,
      clusterSize: 1,
      diffLines: 1,
      filesTouched: 1,
      index: 0,
    };
    const b = {
      clean: true,
      newFailuresCount: 0,
      reproPassed: true,
      extraCasesFailed: 0,
      literalLeaksCount: 0,
      clusterSize: 1,
      diffLines: 1,
      filesTouched: 1,
      index: 1,
    };
    expect(selectBestCandidate([a, b])?.index).toBe(1);
  });

  it('prefers smaller diff', () => {
    const a = {
      clean: true,
      newFailuresCount: 0,
      reproPassed: true,
      extraCasesFailed: 0,
      literalLeaksCount: 0,
      clusterSize: 1,
      diffLines: 10,
      filesTouched: 1,
      index: 0,
    };
    const b = {
      clean: true,
      newFailuresCount: 0,
      reproPassed: true,
      extraCasesFailed: 0,
      literalLeaksCount: 0,
      clusterSize: 1,
      diffLines: 2,
      filesTouched: 1,
      index: 1,
    };
    expect(selectBestCandidate([a, b])?.index).toBe(1);
  });

  it('penalizes literal leaks', () => {
    const a = {
      clean: true,
      newFailuresCount: 0,
      reproPassed: true,
      extraCasesFailed: 0,
      literalLeaksCount: 2,
      clusterSize: 1,
      diffLines: 2,
      filesTouched: 1,
      index: 0,
    };
    const b = {
      clean: true,
      newFailuresCount: 0,
      reproPassed: true,
      extraCasesFailed: 0,
      literalLeaksCount: 0,
      clusterSize: 1,
      diffLines: 2,
      filesTouched: 1,
      index: 1,
    };
    expect(selectBestCandidate([a, b])?.index).toBe(1);
  });

  it('returns null for empty', () => {
    expect(selectBestCandidate([])).toBeNull();
  });

  it('computeRankKey returns tuple', () => {
    const c = {
      clean: true,
      newFailuresCount: 0,
      reproPassed: true,
      extraCasesFailed: 0,
      literalLeaksCount: 0,
      clusterSize: 2,
      diffLines: 3,
      filesTouched: 1,
      index: 5,
    };
    expect(computeRankKey(c)).toEqual([0, 0, 0, 0, 0, -2, 3, 1, 5]);
  });
});

describe('breakers', () => {
  it('B9 axis change on repeated failure key', () => {
    const s = createBreakerState();
    expect(b9AxisChange(s, 'k1')).toBe(false);
    expect(b9AxisChange(s, 'k1')).toBe(true);
  });

  it('B10 early stopping after 2 non-improving rounds', () => {
    const s = createBreakerState();
    expect(b10EarlyStopping(s, false)).toBe(false);
    expect(b10EarlyStopping(s, false)).toBe(true);
  });

  it('detects literal leaks', () => {
    const issue = 'return "SECRET_VALUE"';
    const diff = '+ return "SECRET_VALUE";';
    expect(detectLiteralLeaks(diff, issue)).toBe(1);
  });

  it('escalation rung bounds 0..4', () => {
    expect(escalationRung(10)).toBe(4);
    expect(escalationRung(-1)).toBe(0);
  });
});
