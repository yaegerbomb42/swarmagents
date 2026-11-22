/**
 * Affected-test selection for the oracle gate: the tests worth running for
 * a patch, so the gate does not pay for the whole suite on every candidate.
 *
 * A test is affected when it is
 *   - itself changed by the patch (and not deleted),
 *   - a sibling of a changed module (`a/b.ts` → `a/b.test.ts`,
 *     `a/b.<suffix>.test.ts`),
 *   - a test that imports a changed module by a relative specifier, or
 *   - a test whose relative imports reach a changed module within
 *     {@link TRANSITIVE_HOPS} hops (so indirect callers are selected too).
 */

import { posix as path } from "node:path";

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** How many module levels past a test's direct imports to follow. */
export const TRANSITIVE_HOPS = 2;
const SOURCE_EXTS = ["ts", "tsx", "mts", "cts"] as const;

export function isTestFile(p: string): boolean {
  return TEST_FILE_RE.test(p);
}

/** Strip a source extension: `a/b.ts` → `a/b` (also `a/index.ts` → `a`). */
export function moduleStem(p: string): string {
  return p.replace(SOURCE_EXT_RE, "").replace(/\/index$/, "");
}

/**
 * Relative import specifiers in a source file (import/export from, require,
 * dynamic import). Bare directory imports (`.` and `..`) are included.
 */
export function relativeImports(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:from\s*|require\s*\(\s*|import(?:\s+|\s*\(\s*))["'](\.{1,2}(?:\/[^"']*)?)["']/g;
  for (const m of source.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** Resolve a relative specifier from `importer` to a module stem. */
export function resolveSpecifier(importer: string, specifier: string): string {
  const joined = path.normalize(path.join(path.dirname(importer), specifier));
  return moduleStem(joined.replace(/\.js$/, ".ts"));
}

export interface AffectedTestInput {
  /** Project-relative paths the patch touches, with their status. */
  changed: { path: string; status: "A" | "M" | "D" | "R" }[];
  /** Every test file in the project after the patch (project-relative). */
  allTests: string[];
  /** Contents of a project-relative file after the patch, or undefined. */
  readFile: (p: string) => string | undefined;
}

export function findAffectedTests(input: AffectedTestInput): string[] {
  const tests = new Set(input.allTests);
  const out = new Set<string>();
  const changedStems = new Set<string>();

  for (const file of input.changed) {
    if (isTestFile(file.path)) {
      if (file.status !== "D" && tests.has(file.path)) out.add(file.path);
      continue;
    }
    if (!SOURCE_EXT_RE.test(file.path)) continue;
    changedStems.add(moduleStem(file.path));
    changedStems.add(file.path.replace(SOURCE_EXT_RE, ""));
  }
  if (changedStems.size === 0) return [...out].sort();

  const sourceCache = new Map<string, string | undefined>();
  const readSource = (p: string): string | undefined => {
    if (sourceCache.has(p)) return sourceCache.get(p);
    const text = input.readFile(p);
    sourceCache.set(p, text);
    return text;
  };

  /** Read a module stem from the common source-file spellings. */
  const loadStem = (stem: string): string | undefined => {
    for (const ext of SOURCE_EXTS) {
      const text = readSource(`${stem}.${ext}`);
      if (text !== undefined) return text;
    }
    for (const ext of SOURCE_EXTS) {
      const text = readSource(`${stem}/index.${ext}`);
      if (text !== undefined) return text;
    }
    return undefined;
  };

  /** True when any relative import chain from this module reaches a changed stem. */
  const reachesChanged = (importerPath: string, source: string, hops: number, seen: Set<string>): boolean => {
    for (const spec of relativeImports(source)) {
      const resolved = resolveSpecifier(importerPath, spec);
      if (changedStems.has(resolved)) return true;
      if (hops <= 0 || seen.has(resolved)) continue;
      seen.add(resolved);
      const next = loadStem(resolved);
      if (next !== undefined && reachesChanged(`${resolved}.ts`, next, hops - 1, seen)) return true;
    }
    return false;
  };

  for (const test of tests) {
    const testStem = test.replace(TEST_FILE_RE, "");
    // Sibling: a/b.test.ts or a/b.something.test.ts for changed a/b.ts.
    for (const stem of changedStems) {
      if (testStem === stem || testStem.startsWith(`${stem}.`)) out.add(test);
    }
    if (out.has(test)) continue;
    const source = input.readFile(test);
    if (!source) continue;
    if (reachesChanged(test, source, TRANSITIVE_HOPS, new Set())) out.add(test);
  }
  return [...out].sort();
}
