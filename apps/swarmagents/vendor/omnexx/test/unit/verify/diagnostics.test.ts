import { describe, expect, it } from 'vitest';
import {
  editorToLspCoordinate,
  fingerprintDiagnostic,
  formatDiagnosticsForContext,
  lspToEditorCoordinate,
  normalizeEslintMessage,
  normalizeLspDiagnostic,
  normalizeTscDiagnostic,
} from '../../../src/verify/diagnostics.js';
import type { Diagnostic } from '../../../src/verify/preflight-types.js';

describe('diagnostics normalization and preflight types', () => {
  it('converts between LSP 0-based and editor 1-based coordinates', () => {
    const editor = lspToEditorCoordinate(0, 4);
    expect(editor).toEqual({ line: 1, column: 5 });

    const lsp = editorToLspCoordinate(editor.line, editor.column);
    expect(lsp).toEqual({ line: 0, character: 4 });
  });

  it('normalizes raw LSP diagnostic correctly', () => {
    const raw = {
      range: {
        start: { line: 9, character: 2 },
        end: { line: 9, character: 10 },
      },
      severity: 1,
      code: 'E0308',
      message: 'mismatched types',
      source: 'rustc',
    };

    const norm = normalizeLspDiagnostic('src/lib.rs', raw);
    expect(norm).toEqual({
      file: 'src/lib.rs',
      line: 10,
      column: 3,
      code: 'E0308',
      severity: 'error',
      message: 'mismatched types',
      source: 'rustc',
      fixable: false,
    });
  });

  it('normalizes raw ESLint message correctly', () => {
    const raw = {
      ruleId: '@typescript-eslint/no-unused-vars',
      severity: 2 as const,
      message: "'x' is defined but never used.",
      line: 14,
      column: 7,
      fix: {
        range: [100, 105] as [number, number],
        text: '',
      },
    };

    const norm = normalizeEslintMessage('src/app.ts', raw);
    expect(norm).toEqual({
      file: 'src/app.ts',
      line: 14,
      column: 7,
      code: '@typescript-eslint/no-unused-vars',
      severity: 'error',
      message: "'x' is defined but never used.",
      source: 'eslint',
      fixable: true,
    });
  });

  it('normalizes raw TSC diagnostic correctly', () => {
    const raw = {
      line: 25,
      column: 10,
      code: 2322,
      category: 'error' as const,
      message: "Type 'string' is not assignable to type 'number'.",
    };

    const norm = normalizeTscDiagnostic('src/app.ts', raw);
    expect(norm).toEqual({
      file: 'src/app.ts',
      line: 25,
      column: 10,
      code: 'TS2322',
      severity: 'error',
      message: "Type 'string' is not assignable to type 'number'.",
      source: 'tsc',
      fixable: false,
    });
  });

  it('generates consistent fingerprints for diagnostic diffing', () => {
    const d1: Diagnostic = {
      file: 'src/main.ts',
      line: 5,
      column: 2,
      code: 'TS2304',
      severity: 'error',
      message: "Cannot find name 'foo'.",
      source: 'tsc',
      fixable: false,
    };
    const d2: Diagnostic = { ...d1 };
    expect(fingerprintDiagnostic(d1)).toBe(fingerprintDiagnostic(d2));
    expect(fingerprintDiagnostic(d1)).toBe("src/main.ts:TS2304:5:2:Cannot find name 'foo'.");
  });

  it('formats diagnostics compactly for context feedback', () => {
    const diags: Diagnostic[] = [
      {
        file: 'src/calc.ts',
        line: 12,
        column: 5,
        code: 'TS2322',
        severity: 'error',
        message: "Type 'null' is not assignable to type 'number'.",
        source: 'tsc',
        fixable: false,
      },
      {
        file: 'src/calc.ts',
        line: 18,
        column: 1,
        code: 'semi',
        severity: 'warning',
        message: 'Missing semicolon.',
        source: 'eslint',
        fixable: true,
      },
    ];

    const formatted = formatDiagnosticsForContext(diags);
    expect(formatted).toContain('PREFLIGHT ISSUES:');
    expect(formatted).toContain(
      "[ERROR] src/calc.ts:12:5 TS2322 (tsc): Type 'null' is not assignable to type 'number'.",
    );
  });
});
