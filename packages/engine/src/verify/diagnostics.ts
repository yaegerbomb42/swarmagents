import type { Diagnostic, DiagnosticSeverity } from './preflight-types.js';

/**
 * Converts LSP 0-based { line, character } coordinates into 1-based editor { line, column }.
 */
export function lspToEditorCoordinate(
  line: number,
  character: number,
): { line: number; column: number } {
  return {
    line: Math.max(1, line + 1),
    column: Math.max(1, character + 1),
  };
}

/**
 * Converts 1-based editor { line, column } coordinates into LSP 0-based { line, character }.
 */
export function editorToLspCoordinate(
  line: number,
  column: number,
): { line: number; character: number } {
  return {
    line: Math.max(0, line - 1),
    character: Math.max(0, column - 1),
  };
}

export interface RawLspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number; // 1: Error, 2: Warning, 3: Information, 4: Hint
  code?: string | number;
  source?: string;
  message: string;
}

/**
 * Normalizes an LSP JSON-RPC diagnostic into a standard Omnexx Diagnostic.
 */
export function normalizeLspDiagnostic(
  file: string,
  raw: RawLspDiagnostic,
  defaultSource = 'lsp',
): Diagnostic {
  const coord = lspToEditorCoordinate(raw.range.start.line, raw.range.start.character);
  let severity: DiagnosticSeverity = 'error';
  if (raw.severity === 2) severity = 'warning';
  else if (raw.severity === 3 || raw.severity === 4) severity = 'info';

  return {
    file,
    line: coord.line,
    column: coord.column,
    code: raw.code !== undefined ? String(raw.code) : 'unknown',
    severity,
    message: raw.message.trim(),
    source: raw.source ?? defaultSource,
    fixable: false,
  };
}

export interface RawEslintMessage {
  ruleId: string | null;
  severity: 1 | 2; // 1: warning, 2: error
  message: string;
  line: number;
  column: number;
  fix?: { range: [number, number]; text: string };
}

/**
 * Normalizes an ESLint LintMessage into a standard Omnexx Diagnostic.
 */
export function normalizeEslintMessage(file: string, msg: RawEslintMessage): Diagnostic {
  return {
    file,
    line: Math.max(1, msg.line),
    column: Math.max(1, msg.column),
    code: msg.ruleId ?? 'syntax-error',
    severity: msg.severity === 2 ? 'error' : 'warning',
    message: msg.message.trim(),
    source: 'eslint',
    fixable: msg.fix !== undefined,
  };
}

export interface RawTscDiagnostic {
  line: number;
  column: number;
  code: number | string;
  category: 'error' | 'warning' | 'suggestion' | 'message';
  message: string;
}

/**
 * Normalizes a TypeScript compiler diagnostic into a standard Omnexx Diagnostic.
 */
export function normalizeTscDiagnostic(file: string, raw: RawTscDiagnostic): Diagnostic {
  let severity: DiagnosticSeverity = 'error';
  if (raw.category === 'warning') severity = 'warning';
  else if (raw.category === 'suggestion' || raw.category === 'message') severity = 'info';

  return {
    file,
    line: Math.max(1, raw.line),
    column: Math.max(1, raw.column),
    code: String(raw.code).startsWith('TS') ? String(raw.code) : `TS${String(raw.code)}`,
    severity,
    message: raw.message.trim(),
    source: 'tsc',
    fixable: false,
  };
}

/**
 * Computes a unique fingerprint string for diffing pre-existing vs newly introduced diagnostics.
 */
export function fingerprintDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.code}:${String(d.line)}:${String(d.column)}:${d.message}`;
}

/**
 * Formats a list of diagnostics compactly for tool output feedback into the LLM conversation.
 * Caps at maxErrors and maxChars to prevent context flooding.
 */
export function formatDiagnosticsForContext(
  diagnostics: readonly Diagnostic[],
  maxErrors = 5,
  maxChars = 1_200,
): string {
  if (diagnostics.length === 0) return '';

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const targetList = errors.length > 0 ? errors : warnings;

  const shown = targetList.slice(0, maxErrors);
  const remaining = targetList.length - shown.length;

  const lines = shown.map((d) => {
    const sev = d.severity.toUpperCase();
    const fix = d.fixable ? ' (auto-fixable)' : '';
    const cleanMsg = d.message.length > 180 ? `${d.message.slice(0, 180)}…` : d.message;
    return `[${sev}] ${d.file}:${String(d.line)}:${String(d.column)} ${d.code} (${d.source}): ${cleanMsg}${fix}`;
  });

  if (remaining > 0) {
    lines.push(`[… ${String(remaining)} more diagnostics omitted]`);
  }

  const result = `PREFLIGHT ISSUES:\n${lines.join('\n')}`;
  if (result.length > maxChars) {
    return `${result.slice(0, maxChars - 20)}… [truncated]`;
  }
  return result;
}
