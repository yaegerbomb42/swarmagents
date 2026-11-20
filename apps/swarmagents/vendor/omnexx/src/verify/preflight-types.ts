/**
 * Unified types for the preflight diagnostic interceptor, mutation verification,
 * and multi-language language server diagnostics.
 */

import type { ToolContext } from '../tools/types.js';

export interface PreflightRequest {
  root: string;
  file: string;
  before: string;
  after: string;
  operation: string;
  signal?: AbortSignal;
  ctx?: ToolContext;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  file: string;
  line: number; // 1-based editor line
  column: number; // 1-based editor column
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  source: string; // e.g. 'tsc', 'eslint', 'pyright', 'ruff', 'rustc'
  fixable: boolean;
}

export interface PreflightResult {
  formatted: boolean;
  fixed: number;
  diagnostics: Diagnostic[];
  durationMs: number;
  status: 'clean' | 'issues' | 'skipped';
  tailNote?: string;
  /** The clean, formatted (and autofixed) content ready for the agent to use. */
  content?: string;
  /** The rules auto-fixed by the in-process ESLint pass. */
  rulesFixed?: string[];
}
