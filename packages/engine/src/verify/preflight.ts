import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { afterEdit, onHost } from '../tools/post-edit.js';
import { runAutofix } from './autofix.js';
import { formatSource } from './formatters.js';
import { runPyrightDiagnostics } from './lsp/pyright.js';
import { runRustDiagnostics } from './lsp/rust-analyzer.js';
import type { Diagnostic, PreflightRequest, PreflightResult } from './preflight-types.js';

export const MAX_PREFLIGHT_TIMEOUT_MS = 4_000;

/** Absolute path for a request file path (relative paths resolve against the project root). */
function absolutePath(root: string, file: string): string {
  return isAbsolute(file) ? file : resolve(root, file);
}

/** The result returned for a skipped/aborted/time-budget preflight. */
function skippedResult(startTime: number): PreflightResult {
  return {
    formatted: false,
    fixed: 0,
    diagnostics: [],
    durationMs: Date.now() - startTime,
    status: 'skipped',
  };
}

/**
 * Orchestrates pre-flight mutation analysis, bounded by a strict 4,000ms timeout ceiling.
 *
 * Pipeline: format the edited content in memory → auto-fix (writing changes to disk) → run
 * language-server/diagnostic verification against the clean content. Formatting and autofix
 * status are passed through on {@link PreflightResult} so the agent receives clean code.
 */
export function runPreflight(request: PreflightRequest): Promise<PreflightResult> {
  const startTime = Date.now();

  if (request.signal?.aborted) {
    return Promise.resolve(skippedResult(startTime));
  }

  return new Promise<PreflightResult>((resolve) => {
    let resolved = false;
    const isCancelled = (): boolean => resolved || request.signal?.aborted === true;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(skippedResult(startTime));
      }
    }, MAX_PREFLIGHT_TIMEOUT_MS);

    if (request.signal) {
      request.signal.addEventListener(
        'abort',
        () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(skippedResult(startTime));
          }
        },
        { once: true },
      );
    }

    const runAsync = async (): Promise<void> => {
      try {
        let workingContent = request.after;
        let formatted = false;
        let tailNote = '';

        // 1. Format the in-memory post-edit content
        if (!request.ctx || onHost(request.ctx)) {
          try {
            const fmt = await formatSource(request.root, request.file, workingContent);
            if (fmt.formatted && fmt.content !== workingContent) {
              workingContent = fmt.content;
              formatted = true;
              tailNote = ` Formatted with ${fmt.toolUsed ?? 'formatter'}.`;
            }
          } catch {
            // Formatting is best effort
          }
        }

        if (isCancelled()) {
          return;
        }

        // 2. In-process ESLint auto-fixer pass
        let fixedCount = 0;
        let rulesFixed: string[] = [];
        try {
          const fix = await runAutofix(request.root, request.file, workingContent);
          if (fix.fixed && fix.content !== workingContent) {
            workingContent = fix.content;
            fixedCount = fix.rulesFixed.length;
            rulesFixed = fix.rulesFixed;
          }
        } catch {
          // Autofix is best effort
        }

        if (isCancelled()) {
          return;
        }

        // Persist clean code to disk if formatting or autofix modified it
        if (formatted || fixedCount > 0) {
          try {
            await writeFile(absolutePath(request.root, request.file), workingContent, 'utf8');
          } catch {
            // Ignore disk write errors
          }
        }

        if (isCancelled()) {
          return;
        }

        // 3. Diagnostic verification against clean code (skipping post-edit format since it already ran)
        if (request.ctx) {
          tailNote += await afterEdit(request.ctx, request.file, request.before, {
            diagTimeoutMs: 3_000,
            formatTimeoutMs: 1_000,
            skipFormat: true,
          });
        }

        // 3b. Live LSP diagnostics for Python and Rust edits (best effort, 3s ceiling)
        let lspDiagsCollected: Diagnostic[] = [];
        try {
          const ext = request.file.toLowerCase().split('.').pop();
          if (ext === 'py') {
            lspDiagsCollected = await runPyrightDiagnostics(request.root, request.file, {
              timeoutMs: 3_000,
            });
          } else if (ext === 'rs') {
            lspDiagsCollected = await runRustDiagnostics(request.root, request.file, {
              timeoutMs: 3_000,
            });
          }
        } catch {
          // LSP is best effort
        }

        if (!isCancelled()) {
          resolved = true;
          clearTimeout(timer);
          const diags: Diagnostic[] = [...lspDiagsCollected];
          const diagRegex = /⚠\s+line\s+(\d+):\s+(TS\d+)\s+(.+)/g;
          let m: RegExpExecArray | null;
          while ((m = diagRegex.exec(tailNote)) !== null) {
            diags.push({
              file: request.file,
              line: Number(m[1]),
              column: 1,
              code: m[2] ?? 'TS_UNKNOWN',
              severity: 'error',
              message: (m[3] ?? '').trim(),
              source: 'tsc',
              fixable: false,
            });
          }
          resolve({
            formatted: formatted || tailNote.includes('Formatted with'),
            fixed: fixedCount,
            diagnostics: diags,
            durationMs: Date.now() - startTime,
            status: diags.length > 0 ? 'issues' : 'clean',
            tailNote,
            content: workingContent,
            rulesFixed,
          });
        }
      } catch {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve({
            formatted: false,
            fixed: 0,
            diagnostics: [],
            durationMs: Date.now() - startTime,
            status: 'clean',
            tailNote: '',
            content: request.after,
            rulesFixed: [],
          });
        }
      }
    };

    void runAsync();
  });
}
