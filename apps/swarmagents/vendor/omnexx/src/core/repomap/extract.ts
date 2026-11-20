/**
 * Repository walk + extraction orchestration.
 *
 * File discovery mirrors the codemap's conventions: git-aware when possible (`git ls-files`)
 * with a bounded walk as fallback, dependency/build directories skipped, binaries and
 * oversize files skipped. The whole index is content-independent — extractions depend only
 * on file bytes — so it can sit behind the AST content-addressed cache later without any
 * API change.
 */
import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { BuiltinExtractor } from './builtin.js';
import { languageForPath, sourceExtensions } from './queries.js';
import { TreeSitterExtractor } from './tree-sitter.js';
import type { FileExtraction } from './types.js';

export interface Extractor {
  readonly id: string;
  extract(path: string, text: string): FileExtraction;
}

export interface CreatedExtractor {
  readonly extractor: Extractor;
  /** 'tree-sitter' when the WASM backend loaded, 'builtin' otherwise. */
  readonly engine: 'tree-sitter' | 'builtin';
  /** True when the preferred engine was unavailable and the builtin fallback is in use. */
  readonly degraded: boolean;
  readonly note?: string;
}

/** Largest file parsed for the map. Minified bundles have no useful symbols. */
export const MAX_FILE_BYTES = 1_000_000;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  '__pycache__',
  'venv',
  '.venv',
  '.git',
  '.hg',
  '.svn',
  'Library',
  'Applications',
]);

const SKIP_FILE_RE =
  /\.(min\.(js|css)|map|lock|snap|png|jpe?g|gif|ico|svg|woff2?|ttf|pdf|zip|gz|tar|tgz|dmg|iso)$/i;
const SECRET_FILE_RE =
  /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa(\.pub)?|credentials(\..*)?|\.netrc)$/i;
const TEST_FILE_RE =
  /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$/;

/** Create the extractor for `engine`. `auto` prefers tree-sitter, falls back to builtin. */
export async function createExtractor(
  engine: 'auto' | 'tree-sitter' | 'builtin' = 'auto',
): Promise<CreatedExtractor> {
  if (engine !== 'builtin') {
    const ts = await TreeSitterExtractor.create();
    if (ts) return { extractor: ts, engine: 'tree-sitter', degraded: false };
    const note =
      'tree-sitter backend unavailable (optional packages `web-tree-sitter` / ' +
      '`@s-h-a-d-o-w/tree-sitter-wasms` not installed or a grammar failed to load); ' +
      'using the dependency-free builtin extractor';
    return { extractor: new BuiltinExtractor(), engine: 'builtin', degraded: true, note };
  }
  return { extractor: new BuiltinExtractor(), engine: 'builtin', degraded: false };
}

export interface ExtractRepositoryOptions {
  readonly engine?: 'auto' | 'tree-sitter' | 'builtin';
  /** Include test files (default true). */
  readonly includeTests?: boolean;
  /** Restrict the index to this repo-relative subdirectory (POSIX). */
  readonly subdir?: string;
  /** Keep raw file texts in the result (needed for slicing and raw-dump comparisons). */
  readonly includeTexts?: boolean;
}

export interface RepositoryIndex {
  readonly root: string;
  /** Repo-relative POSIX paths that were extracted, sorted. */
  readonly files: readonly string[];
  /** Candidate files skipped (binary, oversize, secret-looking). */
  readonly skipped: number;
  readonly extractions: readonly FileExtraction[];
  readonly texts: ReadonlyMap<string, string>;
  readonly engine: 'tree-sitter' | 'builtin';
  readonly degraded: boolean;
  readonly note?: string;
  readonly durationMs: number;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Absolute path of the containing git work tree, or null outside a repository. */
function gitToplevel(dir: string): string | null {
  try {
    const out = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (out.status !== 0) return null;
    const top = out.stdout.trim();
    return top.length > 0 ? resolve(top) : null;
  } catch {
    return null;
  }
}

function gitTrackedFiles(base: string): string[] | null {
  try {
    const out = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: base,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.status !== 0) return null;
    return out.stdout
      .split('\0')
      .filter(Boolean)
      .map((p) => p.split(sep).join('/'));
  } catch {
    return null;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dirAbs: string, dirRel: string, depth: number): Promise<void> => {
    if (depth > 8 || out.length >= 20_000) return;
    const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => byCodeUnits(a.name, b.name));
    for (const entry of entries) {
      if (out.length >= 20_000) return;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dirAbs, entry.name);
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(abs, rel, depth + 1);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await visit(root, '', 0);
  return out;
}

/**
 * Walk `root` and extract tags from every supported source file. Deterministic: the file list
 * is sorted, and extractions depend only on file bytes.
 */
export async function extractRepository(
  root: string,
  options: ExtractRepositoryOptions = {},
): Promise<RepositoryIndex> {
  const started = Date.now();
  const { extractor, engine, degraded, note } = await createExtractor(options.engine ?? 'auto');
  const includeTests = options.includeTests ?? true;
  const includeTexts = options.includeTexts ?? true;
  const subdir = options.subdir?.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

  const absRoot = resolve(root);
  // Inside a git repository, paths are relative to the repository root (git toplevel), so
  // stack-trace seeds and subdir filters behave the same from any cwd. Outside git they are
  // relative to `root`.
  const toplevel = gitToplevel(absRoot);
  const base = toplevel ?? absRoot;
  const rootRel = toplevel ? relative(toplevel, absRoot).split(sep).join('/') : '';

  let candidates = gitTrackedFiles(base) ?? (await walkFiles(base));
  candidates = candidates
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !p.startsWith('..') && !p.startsWith('/'))
    .filter((p) => !rootRel || p === rootRel || p.startsWith(`${rootRel}/`))
    .filter((p) => languageForPath(p) !== null)
    .filter((p) => !SKIP_FILE_RE.test(p) && !SECRET_FILE_RE.test(p))
    .filter((p) => includeTests || !TEST_FILE_RE.test(p))
    .filter((p) => !subdir || p === subdir || p.startsWith(`${subdir}/`))
    .sort(byCodeUnits);

  const wantedExtensions = new Set(sourceExtensions());
  const extractions: FileExtraction[] = [];
  const texts = new Map<string, string>();
  let skipped = 0;
  for (const path of candidates) {
    const ext = path.slice(path.lastIndexOf('.'));
    if (!wantedExtensions.has(ext.toLowerCase())) continue;
    const abs = join(base, ...path.split('/'));
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      const text = await readFile(abs, 'utf8');
      if (text.includes('\0')) {
        skipped += 1;
        continue;
      }
      extractions.push(extractor.extract(path, text));
      if (includeTexts) texts.set(path, text);
    } catch {
      skipped += 1;
    }
  }

  return {
    root: absRoot,
    files: extractions.map((e) => e.path),
    skipped,
    extractions,
    texts,
    engine,
    degraded,
    ...(note ? { note } : {}),
    durationMs: Date.now() - started,
  };
}
