/**
 * Affected-test selection for the oracle gate: the tests worth running for
 * a patch, so the gate does not pay for the whole suite on every candidate.
 *
 * A test is affected when it is
 *   - itself changed by the patch (and not deleted),
 *   - a sibling of a changed module (`a/b.ts` → `a/b.test.ts`,
 *     `a/b.<suffix>.test.ts`), or
 *   - a test that imports a changed module by a relative specifier.
 */

import { posix as path } from "node:path";

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function isTestFile(p: string): boolean {
  return TEST_FILE_RE.test(p);
}

/** Strip a source extension: `a/b.ts` → `a/b`. */
export function moduleStem(p: string): string {
  return p.replace(SOURCE_EXT_RE, "").replace(/\/index$/, "");
}

/** Relative import specifiers in a source file (import/export from, require, dynamic import). */
export function relativeImports(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
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
    const stem = moduleStem(file.path);
    changedStems.add(stem);
    changedStems.add(file.path.replace(SOURCE_EXT_RE, ""));
  }
  if (changedStems.size === 0) return [...out].sort();

  for (const test of tests) {
    const testStem = test.replace(TEST_FILE_RE, "");
    // Sibling: a/b.test.ts or a/b.something.test.ts for changed a/b.ts.
    for (const stem of changedStems) {
      if (testStem === stem || testStem.startsWith(`${stem}.`)) out.add(test);
    }
    if (out.has(test)) continue;
    const source = input.readFile(test);
    if (!source) continue;
    for (const spec of relativeImports(source)) {
      if (changedStems.has(resolveSpecifier(test, spec))) {
        out.add(test);
        break;
      }
    }
  }
  return [...out].sort();
}
