/**
 * Tier 1 deterministic execution engine.
 *
 * Handles reconnaissance-shaped tool calls — file reads, directory listings, search, git
 * queries and preflight checks — directly through Node's filesystem/child_process APIs. No
 * model turn, no tool-schema round trip: the caller gets a provider-neutral `tool_result`
 * envelope it can append straight to the conversation.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { globToRegExp } from '../security/glob.js';
import { PathJail, isSecretPath } from '../security/paths.js';
import { listTree } from '../tools/list.js';
import { SKIP_DIRS } from '../tools/search.js';
import type { ToolContext } from '../tools/types.js';
import { runPreflight } from '../verify/preflight.js';

export const FAST_PATH_ACTIONS = [
  'read_file',
  'list_directory',
  'search',
  'git_status',
  'git_diff',
  'run_preflight',
] as const;
export type FastPathAction = (typeof FAST_PATH_ACTIONS)[number];

export interface FastPathRequest {
  /** A canonical action or a common tool-name alias (`read`, `grep`, `git status`…). */
  action: string;
  /** Repository root; all relative paths resolve inside it. */
  root: string;
  /** Target file or directory, relative to `root` (or absolute inside it). */
  path?: string;
  /** Alias for `path`, used by preflight-style callers. */
  file?: string;
  /** Regex/ripgrep pattern for `search`. */
  pattern?: string;
  /** Optional file glob for `search`, e.g. `src/**\/*.ts`. */
  glob?: string;
  /** Directory depth for `list_directory` (default 3). */
  depth?: number;
  /** Extra arguments for the underlying git command. */
  args?: readonly string[];
  /** Preflight fields; `after` defaults to the file's current bytes. */
  before?: string;
  after?: string;
  operation?: string;
  signal?: AbortSignal;
  /** Optional live context: its jail and diagnostics wiring are reused when present. */
  ctx?: ToolContext;
  /** Stable id for the returned envelope; defaults to `fast-path`. */
  toolUseId?: string;
}

/** The provider-neutral tool-result block (`ContentBlock` subset). */
export interface FastPathResult {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

const MAX_HITS = 100;
const MAX_LINE_CHARS = 300;
const MAX_OUTPUT_CHARS = 200_000;
const COMMAND_TIMEOUT_MS = 2_000;

const ACTION_ALIASES: Readonly<Record<string, FastPathAction>> = {
  read: 'read_file',
  readfile: 'read_file',
  read_file: 'read_file',
  cat: 'read_file',
  list: 'list_directory',
  listdir: 'list_directory',
  list_directory: 'list_directory',
  ls: 'list_directory',
  search: 'search',
  grep: 'search',
  rg: 'search',
  git_status: 'git_status',
  gitstatus: 'git_status',
  status: 'git_status',
  git_diff: 'git_diff',
  gitdiff: 'git_diff',
  diff: 'git_diff',
  run_preflight: 'run_preflight',
  runpreflight: 'run_preflight',
  preflight: 'run_preflight',
};

/** Maps tool-name aliases (`git status`, `runPreflight`, `ls`) to a canonical action. */
export function normalizeFastPathAction(action: unknown): FastPathAction | undefined {
  if (typeof action !== 'string') return undefined;
  const key = action
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return ACTION_ALIASES[key];
}

function envelope(request: FastPathRequest, content: string, isError = false): FastPathResult {
  const base: FastPathResult = {
    type: 'tool_result',
    toolUseId: request.toolUseId ?? 'fast-path',
    content: content.length > MAX_OUTPUT_CHARS ? `${content.slice(0, MAX_OUTPUT_CHARS)}…` : content,
  };
  return isError ? { ...base, isError: true } : base;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jailFor(request: FastPathRequest): PathJail {
  return request.ctx?.jail ?? new PathJail(request.root);
}

function resolveInRoot(request: FastPathRequest, target: string): string {
  return jailFor(request).resolve(target, 'read');
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  missing: boolean;
}

/** `execFile` with a hard timeout, never rejecting. */
function command(
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise<CommandResult>((done) => {
    execFile(
      cmd,
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      },
      (err, stdout, stderr) => {
        const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
        const code = err ? 1 : 0;
        done({ code, stdout, stderr, missing });
      },
    );
  });
}

async function readFileAction(request: FastPathRequest): Promise<FastPathResult> {
  const target = request.path ?? request.file;
  if (!target) return envelope(request, 'read_file needs a path', true);
  let abs: string;
  try {
    abs = resolveInRoot(request, target);
  } catch (err) {
    return envelope(request, errorMessage(err), true);
  }
  try {
    return envelope(request, await readFile(abs, 'utf8'));
  } catch (err) {
    return envelope(request, `cannot read ${target}: ${errorMessage(err)}`, true);
  }
}

async function listDirectoryAction(request: FastPathRequest): Promise<FastPathResult> {
  const root = request.ctx?.jail.root ?? request.root;
  const dir = request.path ? resolveInRoot(request, request.path) : root;
  try {
    return envelope(request, await listTree(dir, root, request.depth ?? 3));
  } catch (err) {
    return envelope(request, `cannot list ${request.path ?? '.'}: ${errorMessage(err)}`, true);
  }
}

/** Recursive Node fallback used when ripgrep is absent (or cannot run). */
async function searchWithNode(
  root: string,
  target: string,
  pattern: RegExp,
  glob: string | undefined,
): Promise<string[]> {
  const globRe = glob ? globToRegExp(glob) : undefined;
  const hits: string[] = [];

  const visit = async (abs: string): Promise<void> => {
    if (hits.length >= MAX_HITS) return;
    const info = await stat(abs).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory()) {
      const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.name === '.git' || (entry.isDirectory() && SKIP_DIRS.has(entry.name))) continue;
        if (hits.length >= MAX_HITS) return;
        await visit(resolve(abs, entry.name));
      }
      return;
    }
    if (!info.isFile()) return;
    const rel = relative(root, abs) || basename(abs);
    if (isSecretPath(rel)) return;
    if (globRe && !globRe.test(rel)) return;
    const text = await readFile(abs, 'utf8').catch(() => undefined);
    if (text === undefined || text.includes('\0')) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
      const line = lines[i] ?? '';
      if (!pattern.test(line)) continue;
      hits.push(`${rel}:${String(i + 1)}:${line.slice(0, MAX_LINE_CHARS)}`);
    }
  };

  await visit(target);
  return hits;
}

async function searchAction(request: FastPathRequest): Promise<FastPathResult> {
  if (!request.pattern) return envelope(request, 'search needs a pattern', true);
  const root = request.ctx?.jail.root ?? request.root;
  let target: string;
  try {
    target = request.path ? resolveInRoot(request, request.path) : root;
  } catch (err) {
    return envelope(request, errorMessage(err), true);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(request.pattern);
  } catch (err) {
    return envelope(request, `invalid search pattern: ${errorMessage(err)}`, true);
  }

  const relativeTarget = relative(root, target) || '.';
  const args = [
    '--line-number',
    '--no-heading',
    '--with-filename',
    '--color=never',
    '--max-columns',
    String(MAX_LINE_CHARS),
    '--max-count',
    '20',
    '--max-filesize',
    '2M',
    '--glob',
    '!.git/**',
    ...[...SKIP_DIRS].flatMap((dir) => ['--glob', `!**/${dir}/**`]),
    ...(request.glob ? ['--glob', request.glob] : []),
    '--no-messages',
    '-e',
    request.pattern,
    relativeTarget,
  ];
  const result = await command('rg', args, root);

  let lines: string[];
  if (result.missing) {
    lines = await searchWithNode(root, target, regex, request.glob);
  } else if (result.code === 0 || (result.code === 1 && !result.stderr.trim())) {
    lines = result.stdout.split('\n').filter(Boolean);
  } else {
    // Exit 2 can still carry useful output when only some files were unreadable.
    lines = result.stdout.trim()
      ? result.stdout.split('\n').filter(Boolean)
      : await searchWithNode(root, target, regex, request.glob);
  }

  return envelope(request, lines.length ? lines.slice(0, MAX_HITS).join('\n') : '(no matches)');
}

async function gitAction(
  request: FastPathRequest,
  mode: 'status' | 'diff',
): Promise<FastPathResult> {
  const extra = [...(request.args ?? [])];
  const args =
    mode === 'status' ? ['status', '--short', ...extra] : ['diff', '--no-color', ...extra];
  const result = await command('git', args, request.root);
  if (result.missing) return envelope(request, 'git is not installed', true);
  if (result.code !== 0) {
    return envelope(
      request,
      result.stderr.trim() || `git ${mode === 'status' ? 'status' : 'diff'} failed`,
      true,
    );
  }
  const output = result.stdout.trim();
  if (output) return envelope(request, output);
  return envelope(request, mode === 'status' ? '(clean)' : '(no changes)');
}

async function preflightAction(request: FastPathRequest): Promise<FastPathResult> {
  const target = request.file ?? request.path;
  if (!target) return envelope(request, 'run_preflight needs a file', true);

  let abs: string;
  try {
    abs = resolveInRoot(request, target);
  } catch (err) {
    return envelope(request, errorMessage(err), true);
  }

  let after = request.after;
  if (after === undefined) {
    try {
      after = await readFile(abs, 'utf8');
    } catch (err) {
      return envelope(request, `cannot read ${target}: ${errorMessage(err)}`, true);
    }
  }

  const result = await runPreflight({
    root: request.root,
    file: abs,
    before: request.before ?? after,
    after,
    operation: request.operation ?? 'fast_path',
    ...(request.ctx ? { ctx: request.ctx } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  const note = result.tailNote?.trim() ?? '';
  const content =
    note ||
    `preflight ${result.status}: formatted=${String(result.formatted)} diagnostics=${String(
      result.diagnostics.length,
    )} (${String(result.durationMs)}ms)`;
  return envelope(request, content);
}

/**
 * Executes a Tier 1 request locally. Always resolves to a `tool_result`; unsupported actions
 * and I/O failures become `isError` envelopes instead of exceptions.
 */
export async function executeFastPath(request: FastPathRequest): Promise<FastPathResult> {
  if (!request.root) return envelope(request, 'fast path needs a root', true);

  const action = normalizeFastPathAction(request.action);
  if (!action) {
    return envelope(request, `fast path cannot handle action "${request.action}"`, true);
  }

  try {
    switch (action) {
      case 'read_file':
        return await readFileAction(request);
      case 'list_directory':
        return await listDirectoryAction(request);
      case 'search':
        return await searchAction(request);
      case 'git_status':
        return await gitAction(request, 'status');
      case 'git_diff':
        return await gitAction(request, 'diff');
      case 'run_preflight':
        return await preflightAction(request);
    }
  } catch (err) {
    return envelope(request, errorMessage(err), true);
  }
}
