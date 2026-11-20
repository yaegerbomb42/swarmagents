import { describe, expect, it } from 'vitest';
import { diffDiagnostics } from '../../../src/verify/diagnostic-baseline.js';
import { formatDiagnosticsForContext } from '../../../src/verify/diagnostics.js';
import type { Diagnostic } from '../../../src/verify/preflight-types.js';

describe('diagnostic baseline diffing (Step 1.5)', () => {
  it('reports exactly 1 new error when editing a file with 10 pre-existing errors', () => {
    // 10 pre-existing errors in repository
    const baseline: Diagnostic[] = Array.from({ length: 10 }, (_, i) => ({
      file: 'src/legacy.ts',
      line: i + 1,
      column: 1,
      code: `TS${String(2000 + i)}`,
      severity: 'error',
      message: `Pre-existing legacy type error #${String(i + 1)}`,
      source: 'tsc',
      fixable: false,
    }));

    // 1 new error introduced by current edit
    const newRegression: Diagnostic = {
      file: 'src/legacy.ts',
      line: 42,
      column: 5,
      code: 'TS2322',
      severity: 'error',
      message: "Type 'string' is not assignable to type 'number'.",
      source: 'tsc',
      fixable: false,
    };

    const postMutation = [...baseline, newRegression];

    const diff = diffDiagnostics(baseline, postMutation);

    expect(diff.newDiagnostics).toHaveLength(1);
    expect(diff.newDiagnostics[0]).toEqual(newRegression);
    expect(diff.unchangedDiagnostics).toHaveLength(10);
    expect(diff.fixedDiagnostics).toHaveLength(0);
    expect(diff.hasNewErrors).toBe(true);

    // Formatted feedback only reports the new regression
    const feedback = formatDiagnosticsForContext(diff.newDiagnostics);
    expect(feedback).toContain('TS2322');
    expect(feedback).toContain("Type 'string' is not assignable to type 'number'.");
    expect(feedback).not.toContain('TS2000');
  });

  it('detects when an edit fixes existing errors without introducing new ones', () => {
    const error1: Diagnostic = {
      file: 'src/calc.ts',
      line: 10,
      column: 2,
      code: 'TS2304',
      severity: 'error',
      message: "Cannot find name 'missing'.",
      source: 'tsc',
      fixable: false,
    };
    const error2: Diagnostic = {
      file: 'src/calc.ts',
      line: 20,
      column: 2,
      code: 'TS2304',
      severity: 'error',
      message: "Cannot find name 'other'.",
      source: 'tsc',
      fixable: false,
    };

    const before = [error1, error2];
    const after = [error2]; // error1 was resolved

    const diff = diffDiagnostics(before, after);
    expect(diff.newDiagnostics).toHaveLength(0);
    expect(diff.fixedDiagnostics).toHaveLength(1);
    expect(diff.fixedDiagnostics[0]).toEqual(error1);
    expect(diff.hasNewErrors).toBe(false);
  });
});
