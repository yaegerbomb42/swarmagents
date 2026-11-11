/**
 * Unified multi-language formatting dispatcher.
 *
 * Formatting previously lived inside `post-edit.ts` as a disk-mutating `--write` pass. This
 * module is the single source of truth for *which* formatter a project uses and how to invoke
 * it, but it works on an in-memory buffer: the caller decides whether to persist the result.
 *
 * Every formatter is bounded by `MAX_FORMAT_TIMEOUT_MS` (500ms). A missing binary, a missing
 * project config, a non-zero exit, or a timeout degrades to the original content — formatting
 * never fails an edit.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';

/** Hard ceiling for a single formatter invocation. */
export const MAX_FORMAT_TIMEOUT_MS = 500;

export interface FormatResult {
  /** True when a project formatter ran successfully (even if it left the content unchanged). */
  formatted: boolean;
  /** Formatted content on success, or the original content on any skip/failure. */
  content: string;
  /** Formatter that produced the result, e.g. `prettier`, `ruff`, `gofmt`, `rustfmt`. */
  toolUsed?: string;
}

type FormatterTool = 'prettier' | 'ruff' | 'gofmt' | 'rustfmt';

interface FormatterSpec {
  tool: FormatterTool;
  command: string;
  args: string[];
}

const PRETTIER_EXT = /\.(?:[cm]?[jt]sx?|mts|cts|json|jsonc|css|scss|less|md|mdx|ya?ml|html|vue)$/i;

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.json5',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
];

/** Upper bound on captured stdout/stderr, so a runaway formatter cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function hasPrettierConfig(root: string): boolean {
  if (PRETTIER_CONFIGS.some((f) => existsSync(join(root, f)))) return true;
  try {
    return 'prettier' in (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as object);
  } catch {
    return false;
  }
}

function hasRuffConfig(root: string): boolean {
  if (existsSync(join(root, 'ruff.toml')) || existsSync(join(root, '.ruff.toml'))) return true;
  try {
    return readFileSync(join(root, 'pyproject.toml'), 'utf8').includes('[tool.ruff');
  } catch {
    return false;
  }
}

/**
 * A project-local executable, or undefined when the project hasn't installed one. Checking
 * local paths before PATH keeps a repo pinned to its own formatter version.
 */
function localBin(root: string, name: string): string | undefined {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const candidates = [
    join(root, 'node_modules', '.bin', `${name}${suffix}`),
    join(root, '.venv', 'bin', `${name}${suffix}`),
    join(root, 'venv', 'bin', `${name}${suffix}`),
    join(root, 'bin', `${name}${suffix}`),
    join(root, '.bin', `${name}${suffix}`),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Picks the formatter for a file. Prettier and Ruff are opt-in via project config, the same
 * rule `post-edit.ts` uses; Go and Rust format with tool defaults and therefore need no config.
 */
function formatterFor(root: string, abs: string): FormatterSpec | undefined {
  const ext = extname(abs).toLowerCase();

  // JavaScript / TypeScript (and the other languages Prettier handles).
  if (PRETTIER_EXT.test(abs) && hasPrettierConfig(root)) {
    const command = localBin(root, 'prettier');
    if (!command) return undefined;
    return {
      tool: 'prettier',
      command,
      args: ['--stdin-filepath', abs, '--log-level', 'warn'],
    };
  }

  // Python.
  if ((ext === '.py' || ext === '.pyi') && hasRuffConfig(root)) {
    return {
      tool: 'ruff',
      command: localBin(root, 'ruff') ?? 'ruff',
      args: ['format', '--stdin-filename', abs, '-'],
    };
  }

  // Go.
  if (ext === '.go') {
    return { tool: 'gofmt', command: localBin(root, 'gofmt') ?? 'gofmt', args: [] };
  }

  // Rust.
  if (ext === '.rs') {
    return {
      tool: 'rustfmt',
      command: localBin(root, 'rustfmt') ?? 'rustfmt',
      args: ['--emit', 'stdout'],
    };
  }

  return undefined;
}

function clampedTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return MAX_FORMAT_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(timeoutMs), MAX_FORMAT_TIMEOUT_MS));
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a formatter with `content` on stdin and collects stdout, with a hard kill on timeout. */
function runWithStdin(
  command: string,
  args: readonly string[],
  content: string,
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise<RunResult>((done) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      done({ ok: false, stdout, stderr, timedOut: false });
      return;
    }

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ok, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
      finish(false);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
      else {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish(false);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
    });
    child.once('error', () => {
      finish(false);
    });
    child.once('close', (code) => {
      finish(code === 0 && !timedOut);
    });

    // A formatter that exits before reading stdin makes this pipe EPIPE; it is not a failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(content);
  });
}

/**
 * Formats `content` as if it were the file at `file` (absolute, or relative to `root`), using
 * the project's own formatter and config. Never writes to disk and never throws.
 *
 * `timeoutMs` may lower the budget (useful in tests) but can never exceed 500ms.
 */
export async function formatSource(
  root: string,
  file: string,
  content: string,
  timeoutMs?: number,
): Promise<FormatResult> {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  const spec = formatterFor(root, abs);
  if (!spec) return { formatted: false, content };

  const result = await runWithStdin(
    spec.command,
    spec.args,
    content,
    root,
    clampedTimeout(timeoutMs),
  );

  // A successful formatter with non-empty input must emit something; silence means it did not
  // understand the invocation (for example a shim that only supports `--write`).
  if (!result.ok || (result.stdout.length === 0 && content.length > 0)) {
    return { formatted: false, content };
  }

  return { formatted: true, content: result.stdout, toolUsed: spec.tool };
}
