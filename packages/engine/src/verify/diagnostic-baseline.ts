import type { Diagnostic } from './preflight-types.js';
import { fingerprintDiagnostic } from './diagnostics.js';

export interface DiagnosticDiffResult {
  newDiagnostics: Diagnostic[];
  fixedDiagnostics: Diagnostic[];
  unchangedDiagnostics: Diagnostic[];
  hasNewErrors: boolean;
}

/**
 * Compares post-mutation diagnostics against a pre-mutation baseline.
 * Filters out pre-existing repository issues so only newly introduced regressions
 * are reported to the model.
 */
export function diffDiagnostics(
  before: readonly Diagnostic[],
  after: readonly Diagnostic[],
): DiagnosticDiffResult {
  const beforeCounts = new Map<string, number>();
  for (const d of before) {
    const fp = fingerprintDiagnostic(d);
    beforeCounts.set(fp, (beforeCounts.get(fp) ?? 0) + 1);
  }

  const newDiagnostics: Diagnostic[] = [];
  const unchangedDiagnostics: Diagnostic[] = [];

  for (const d of after) {
    const fp = fingerprintDiagnostic(d);
    const count = beforeCounts.get(fp) ?? 0;
    if (count > 0) {
      beforeCounts.set(fp, count - 1);
      unchangedDiagnostics.push(d);
    } else {
      newDiagnostics.push(d);
    }
  }

  const afterCounts = new Map<string, number>();
  for (const d of after) {
    const fp = fingerprintDiagnostic(d);
    afterCounts.set(fp, (afterCounts.get(fp) ?? 0) + 1);
  }

  const fixedDiagnostics: Diagnostic[] = [];
  for (const d of before) {
    const fp = fingerprintDiagnostic(d);
    const count = afterCounts.get(fp) ?? 0;
    if (count > 0) {
      afterCounts.set(fp, count - 1);
    } else {
      fixedDiagnostics.push(d);
    }
  }

  const hasNewErrors = newDiagnostics.some((d) => d.severity === 'error');

  return {
    newDiagnostics,
    fixedDiagnostics,
    unchangedDiagnostics,
    hasNewErrors,
  };
}
