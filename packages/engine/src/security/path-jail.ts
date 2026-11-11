import { accessSync, constants, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PolicyError } from '../errors.js';

export type PathJailMode = 'read' | 'write';

export interface PathJailOptions {
  /** Check permissions for read-only vs read-write access. Defaults to 'read'. */
  mode?: PathJailMode;
  /**
   * When false (default for write), a missing candidate path is allowed as long as its
   * canonical location is inside the jail. For read mode, defaults to true.
   */
  requireExists?: boolean;
}

/** Thrown when a candidate path escapes the jail root or violates jail constraints. */
export class PathJailViolationError extends PolicyError {
  readonly candidatePath: string;
  readonly rootDir: string;
  readonly resolvedPath: string | undefined;
  readonly reason:
    | 'null-byte'
    | 'outside-root'
    | 'symlink-escape'
    | 'not-found'
    | 'permission-denied'
    | 'invalid-root';

  constructor(opts: {
    message: string;
    candidatePath: string;
    rootDir: string;
    reason: PathJailViolationError['reason'];
    resolvedPath?: string;
    hint?: string;
  }) {
    super(opts.message, opts.hint);
    this.name = 'PathJailViolationError';
    this.candidatePath = opts.candidatePath;
    this.rootDir = opts.rootDir;
    this.reason = opts.reason;
    if (opts.resolvedPath !== undefined) this.resolvedPath = opts.resolvedPath;
  }
}

const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';

function normCase(p: string): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

/** True when target is the same as root or a descendant of root (no traversal escape). */
export function isPathInsideRoot(root: string, target: string): boolean {
  const a = normCase(root);
  const b = normCase(target);
  if (a === b) return true;
  const rel = relative(a, b);
  // A child named `..foo` is inside; only `..` / `../...` and absolute escapes are outside.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolve a path to its canonical real location. For missing tail segments, resolves the
 * deepest existing ancestor via realpath and re-appends the missing tail so symlink
 * breakouts through non-existent children are still detected.
 */
function canonicalizePath(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

function canonicalizeRoot(rootDir: string): string {
  try {
    return realpathSync.native(resolve(rootDir));
  } catch {
    throw new PathJailViolationError({
      message: `jail root cannot be resolved: ${rootDir}`,
      candidatePath: rootDir,
      rootDir,
      reason: 'invalid-root',
      hint: 'ensure the jail root directory exists and is accessible',
    });
  }
}

function assertExistsOrAllowed(
  canonical: string,
  opts: { requireExists: boolean; candidatePath: string; rootDir: string },
): void {
  if (!opts.requireExists) return;
  try {
    accessSync(canonical, constants.F_OK);
  } catch {
    throw new PathJailViolationError({
      message: `${opts.candidatePath} does not exist inside the jail`,
      candidatePath: opts.candidatePath,
      rootDir: opts.rootDir,
      resolvedPath: canonical,
      reason: 'not-found',
    });
  }
}

function nearestExisting(path: string): string {
  let current = path;
  for (;;) {
    try {
      accessSync(current, constants.F_OK);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function assertPermissions(
  canonical: string,
  mode: PathJailMode,
  candidatePath: string,
  rootDir: string,
): void {
  const target = mode === 'write' ? nearestExisting(canonical) : canonical;
  const mask = mode === 'write' ? constants.W_OK : constants.R_OK;
  try {
    // R_OK/W_OK checks effective permissions; F_OK is required for read targets.
    if (mode === 'read') accessSync(target, constants.F_OK);
    accessSync(target, mask);
  } catch {
    throw new PathJailViolationError({
      message: `${mode} access denied for ${candidatePath}`,
      candidatePath,
      rootDir,
      resolvedPath: canonical,
      reason: 'permission-denied',
      hint:
        mode === 'write'
          ? 'path is read-only or the nearest existing parent is not writable'
          : 'path is not readable',
    });
  }
}

/**
 * Assert that a candidate path resolves inside `rootDir` (the path jail) and return its
 * canonical absolute path.
 *
 * Prevents directory traversal (`../`), null-byte injection, and symlink breakout by
 * resolving realpaths (including the deepest existing ancestor for missing tails).
 * Supports read-only vs read-write permission checking via `options.mode`.
 *
 * Signature (as required): `assertPathInJail(candidatePath, rootDir)` returns a jailed path
 * string and throws `PathJailViolationError` on escape/violation. The optional third
 * argument enables `read`/`write` permission checks.
 */
export function assertPathInJail(
  candidatePath: string,
  rootDir: string,
  options?: PathJailMode | PathJailOptions,
): string {
  const opts: PathJailOptions = typeof options === 'string' ? { mode: options } : (options ?? {});
  const mode = opts.mode ?? 'read';
  const requireExists = opts.requireExists ?? mode === 'read';

  if (candidatePath.includes('\0') || rootDir.includes('\0')) {
    throw new PathJailViolationError({
      message: 'path contains a NUL byte',
      candidatePath,
      rootDir,
      reason: 'null-byte',
    });
  }

  const root = canonicalizeRoot(rootDir);
  const abs = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(root, candidatePath);
  const canonical = canonicalizePath(abs);

  if (!isPathInsideRoot(root, canonical)) {
    // Distinguish symlink escape when the lexical path looked inside but realpath moved it.
    const lexical = isAbsolute(candidatePath)
      ? resolve(candidatePath)
      : resolve(root, candidatePath);
    const lexicallyInside = isPathInsideRoot(root, resolve(lexical));
    throw new PathJailViolationError({
      message: `${candidatePath} resolves outside the jail root`,
      candidatePath,
      rootDir: root,
      resolvedPath: canonical,
      reason: lexicallyInside ? 'symlink-escape' : 'outside-root',
      hint: 'file operations must stay inside the configured jail root',
    });
  }

  assertExistsOrAllowed(canonical, { requireExists, candidatePath, rootDir: root });
  assertPermissions(canonical, mode, candidatePath, root);

  return canonical;
}
