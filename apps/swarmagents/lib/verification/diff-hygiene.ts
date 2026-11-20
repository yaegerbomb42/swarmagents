/**
 * Stage 0 — Diff Hygiene (pure, unit-testable).
 *
 * Port of the standalone engine's `checkDiffHygiene` / `findChangedAssertions`
 * (packages/engine/src/autonomous/verification-pipeline.ts), adapted to the
 * SwarmAgents — NOT a verbatim copy:
 *
 * - The secret scan reuses SwarmAgents' own `SECRET_PATTERNS` from
 *   lib/harness/redact.ts instead of the standalone's `../security/secret-scan.js`
 *   (an omnexx-internal import that does not exist here).
 * - The glob matcher is a small local implementation (`matchesDenylist`); the
 *   SwarmAgents has no `../security/glob.js`.
 * - Test-file / TS-source detection is local regex, matching SwarmAgents'
 *   existing convention (lib/codebase/parse.ts: `/\.(test|spec)\./`).
 * - `findChangedAssertions` drops the asserted-expression (`actual`)
 *   comparison: the sibling worker's `ExpectedAssertion` contract carries
 *   `{ testTitle, matcher, expected, line }` with no `actual` field, so the
 *   port compares matcher + expected value only. If the sibling's port later
 *   adds `actual`, the comparison can be re-added in `findChangedAssertions`
 *   alone — nothing else changes.
 * - `gradeCritic` / `CRITIC_SYSTEM` are deliberately NOT ported: the
 *   SwarmAgents' lib/verification.ts `verifyPhase` already has a generic critic
 *   (passed/score/violations, no 1–5 dimension grades), so a graded-critic
 *   helper would have no call site. The test-expectation-aware rejection rule
 *   the brief calls out is implemented deterministically here instead
 *   (weakened-expectation + test-only-diff violations below) — strictly
 *   stronger than a prompt rule.
 * - The oscillation check (blobShas / recentBlobHistory) is ported but the
 *   gate does not wire history yet — there is no blob-history store in the
 *   SwarmAgents; that is a follow-up, not a silent drop.
 */

import { analyzeSourceText, extractExpectations } from "./ast-analysis";
import { SECRET_PATTERNS } from "../harness/redact";

/**
 * Safety denylist — paths an agent run must never touch. Adapted from the
 * standalone's list; omnexx-specific entries are NOT copied (no omnexx.toml,
 * .omnexx/, CLAUDE.md, AGENTS.md in this repo). What is here and why:
 * - `api_keys.md` — the repo-root file holding real provider keys; it is
 *   git-tracked, so the denylist is the only thing standing between an agent
 *   diff and a leaked key.
 * - `.env*` / `*.pem` / `*.key` — credentials, same as upstream.
 * - `node_modules/**`, `coverage/**`, `.next/**`, `dist/**` — generated or
 *   third-party output; an agent editing these is either confused or gaming
 *   a gate (e.g. editing built output instead of source).
 * - `.github/**` — CI configuration; changing the pipeline from inside a run
 *   is out of scope for the agent.
 * - lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
 *   `bun.lockb`) — machine-generated. Deliberate trade-off, flagged for the
 *   coordinator: an agent that legitimately adds a dependency (via `npm
 *   install`) will trip this and get bounced with a remediation prompt.
 *   That is the intended posture — dependency changes need human review —
 *   but if it proves too strict, lockfiles are the first entries to relax.
 */
export const SAFETY_DENYLIST: readonly string[] = [
  "api_keys.md",
  ".env*",
  "*.pem",
  "*.key",
  "node_modules/**",
  "coverage/**",
  ".next/**",
  "dist/**",
  ".github/**",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
];

/** A test file: `*.test.*` or `*.spec.*` in any JS/TS flavour. */
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
export function isTestFilePath(filePath: string): boolean {
  return TEST_FILE_RE.test(filePath);
}

/** A TypeScript source file (the only kind syntax diagnostics apply to). */
const TS_SOURCE_RE = /\.(ts|tsx|mts|cts)$/i;
export function isTypeScriptSourcePath(filePath: string): boolean {
  return TS_SOURCE_RE.test(filePath);
}

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Minimal glob → RegExp: `*` stays inside one path segment, `**` crosses `/`. */
function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExpChar(ch);
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * Match a repo-relative file against denylist patterns. A pattern with no `/`
 * matches the file's basename at any depth (`*.pem`, `.env*`, `api_keys.md`);
 * a pattern with `/` matches the full path (`node_modules/**`).
 */
export function matchesDenylist(file: string, patterns: readonly string[]): string | undefined {
  const basename = file.split("/").pop() ?? file;
  for (const pattern of patterns) {
    const candidate = pattern.includes("/") ? file : basename;
    if (globToRegExp(pattern).test(candidate)) return pattern;
  }
  return undefined;
}

/** Human label for a redact.ts secret pattern, derived from its source. */
function secretPatternLabel(source: string): string {
  if (source.startsWith("sk-ant-")) return "Anthropic API key";
  if (source.startsWith("sk-")) return "OpenAI-style API key";
  if (source.startsWith("gh[pousr]_")) return "GitHub token";
  if (source.startsWith("github_pat_")) return "GitHub fine-grained PAT";
  if (source.startsWith("AKIA")) return "AWS access key ID";
  if (source.startsWith("xox")) return "Slack token";
  if (/^Bearer /i.test(source)) return "Bearer token";
  return "known credential shape";
}

export interface SecretFinding {
  file: string;
  line: number;
  reason: string;
}

/**
 * Scan added (`+`) lines of a unified diff for secret-shaped values, using
 * SwarmAgents' SECRET_PATTERNS. Returns file + new-file line number per
 * hit. Handles both real `git diff` output and the synthetic untracked-file
 * diffs `collectWorktreeDiff` emits (which carry proper `@@ -0,0 +1,N @@`
 * hunks, so line numbers are exact).
 */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file = "";
  let newLine = 0;
  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ ")) {
      file = rawLine.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      const plus = /\+(\d+)(?:,(\d+))? @@/.exec(rawLine);
      newLine = plus ? Number.parseInt(plus[1] ?? "1", 10) : 0;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      // Context line: present in the new file, so it advances the counter.
      newLine++;
      continue;
    }
    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) continue; // removed line: no advance
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) continue;
    const text = rawLine.slice(1);
    for (const { pattern } of SECRET_PATTERNS) {
      // SECRET_PATTERNS carry the /g flag — test against a fresh regex so
      // lastIndex state never leaks between lines.
      const fresh = new RegExp(pattern.source, pattern.flags.replace("g", ""));
      if (fresh.test(text)) {
        findings.push({
          file,
          line: newLine,
          reason: secretPatternLabel(pattern.source),
        });
        break;
      }
    }
    newLine++;
  }
  return findings;
}

export interface DiffHygieneInput {
  /** Unified diff of the change (tracked files) + synthetic diffs for new files. */
  diff: string;
  changedFiles: readonly string[];
  /** Current blob SHA per changed file (via `git hash-object`), for oscillation. */
  blobShas?: ReadonlyMap<string, string> | undefined;
  /** Blob SHAs a recent autonomous task replaced — restoring one is oscillation. */
  recentBlobHistory?: readonly string[] | undefined;
  /** Assertion count in the changed test files before this task (from HEAD). */
  baselineAssertionCount?: number | undefined;
  /** Read a changed file's current content from the worktree. */
  readFile?: (relPath: string) => string | undefined;
  /**
   * Read a changed file's HEAD content; undefined when the file is new (no
   * HEAD version). Without this the weakened-expectation / test-only checks
   * below cannot compare, so they are skipped — the gate always provides it.
   */
  readHeadFile?: (relPath: string) => string | undefined;
}

export interface DiffHygieneResult {
  clean: boolean;
  violations: string[];
  assertionCount: number;
  changedTestFiles: string[];
}

/**
 * One `expect(...)` assertion whose expected value or matcher changed between
 * two versions of a test file — or that was removed.
 */
export interface ChangedAssertion {
  file: string;
  testTitle: string;
  matcher: string;
  /** Expected value before the change (`toBe(5)` → `5`). */
  before: string;
  /** Expected value after the change; null when the assertion was removed. */
  after: string | null;
}

/** Module path with its code extension (and a trailing `/index`) stripped, so `src/adder.ts` matches an import of `../src/adder.js`. */
function normalizeModulePath(file: string): string {
  return file.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, "").replace(/\/index$/, "");
}

/** Resolve a relative import specifier to a repo-relative module path, or null for bare specifiers. */
export function resolveTestImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const resolved = normalizeModulePath(parts.join("/"));
  return resolved || null;
}

/**
 * Compare the `expect(...).toBe/toEqual/toStrictEqual(<literal>)` assertions
 * in two versions of a test file. Assertions are keyed by test title plus
 * their ordinal within that title, so a reordered test still lines up.
 * Added assertions are NOT reported (adding tests is legitimate); a changed
 * expected value / matcher, or a removed assertion, is.
 * Pure and deterministic — no filesystem access.
 */
export function findChangedAssertions(
  headContent: string,
  currentContent: string,
  file: string,
): ChangedAssertion[] {
  const keyed = (
    list: Array<{ testTitle: string; matcher: string; expected: string }>,
  ): Map<string, { testTitle: string; matcher: string; expected: string }> => {
    const seen = new Map<string, number>();
    const out = new Map<string, { testTitle: string; matcher: string; expected: string }>();
    for (const a of list) {
      const n = (seen.get(a.testTitle) ?? 0) + 1;
      seen.set(a.testTitle, n);
      out.set(`${a.testTitle}\0${n}`, a);
    }
    return out;
  };
  const before = keyed(extractExpectations(headContent, file));
  const after = keyed(extractExpectations(currentContent, file));
  const changed: ChangedAssertion[] = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) {
      changed.push({
        file,
        testTitle: b.testTitle,
        matcher: b.matcher,
        before: b.expected,
        after: null,
      });
    } else if (a.matcher !== b.matcher || a.expected !== b.expected) {
      changed.push({
        file,
        testTitle: b.testTitle,
        matcher: b.matcher,
        before: b.expected,
        after: a.expected,
      });
    }
  }
  return changed;
}

/**
 * Forbidden paths, secret scan on added lines, test-file AST checks
 * (assertion count vs baseline, no added `.skip` / `.only`), and the
 * cross-task oscillation check. Pure except for `readFile` / `readHeadFile`.
 *
 * Test-gaming checks (live case 2026-11-06: the executor changed
 * `toBe(5)` → `toBe(6)` in a test and never touched the source, and the old
 * checks passed because the assertion count was unchanged):
 * - **Weakened expectations:** an existing assertion whose expected value
 *   or matcher changed (or that was removed) is a violation unless the
 *   source file under test changed in the same diff (resolved through the
 *   test file's relative imports; when the test imports no repo source, any
 *   changed non-test file excuses it).
 * - **Test-only diff:** when every changed file is a test file, rewriting
 *   existing expectations without changing any source file is a violation —
 *   a fix must change source. Pure additions pass: a brand-new test file,
 *   or new assertions added to an existing test file without touching the
 *   old ones. Deliberate limit: changing an existing expectation is never
 *   acceptable from the agent, even for a "fix the test itself" task —
 *   that is human work, because no check can tell a corrected expectation
 *   from a weakened one.
 */
export function checkDiffHygiene(input: DiffHygieneInput): DiffHygieneResult {
  const violations: string[] = [];

  for (const file of input.changedFiles) {
    const hit = matchesDenylist(file, SAFETY_DENYLIST);
    if (hit) violations.push(`forbidden path touched: ${file} (matches ${hit})`);
  }

  const secrets = scanDiffForSecrets(input.diff);
  for (const f of secrets) {
    violations.push(`secret in ${f.file}:${f.line} — ${f.reason}`);
  }

  // Corrupt or incomplete generations: the TypeScript parser is error-tolerant, so a broken file
  // still produces partial assertion counts. Report the diagnostics here so the task is sent back
  // with real feedback, never shipped.
  for (const file of input.changedFiles) {
    if (!isTypeScriptSourcePath(file)) continue;
    const content = input.readFile?.(file);
    if (content === undefined) continue;
    const { syntaxErrors } = analyzeSourceText(content, file);
    for (const d of syntaxErrors.slice(0, 3)) {
      const at = d.line > 0 ? `:${d.line}:${d.column}` : "";
      violations.push(`syntax error in ${file}${at}: ${d.message}`);
    }
    if (syntaxErrors.length > 3) {
      violations.push(
        `…and ${syntaxErrors.length - 3} more syntax error(s) in ${file} (fix the file before rerunning)`,
      );
    }
  }

  if (input.recentBlobHistory?.length && input.blobShas) {
    const history = new Set(input.recentBlobHistory);
    for (const [file, sha] of input.blobShas) {
      if (history.has(sha)) {
        violations.push(
          `oscillation: ${file} restores blob ${sha.slice(0, 12)} replaced by a recent autonomous task`,
        );
      }
    }
  }

  const changedTestFiles = input.changedFiles.filter(isTestFilePath);
  const changedSourceFiles = input.changedFiles.filter((f) => !isTestFilePath(f));
  const changedSourceModules = new Set(changedSourceFiles.map(normalizeModulePath));
  let assertionCount = 0;
  for (const file of changedTestFiles) {
    const content = input.readFile?.(file);
    if (content === undefined) continue;
    const analysis = analyzeSourceText(content, file);
    assertionCount += analysis.assertionCount;
    if (analysis.hasSkipOrOnly) {
      violations.push(`added .skip/.only (or xdescribe/xit/fit) in ${file}`);
    }
  }
  if (input.baselineAssertionCount !== undefined && assertionCount < input.baselineAssertionCount) {
    violations.push(
      `assertion count in changed tests fell ${input.baselineAssertionCount} → ${assertionCount}`,
    );
  }

  // Weakened expectations + test-only diff (needs HEAD content to compare).
  if (input.readHeadFile) {
    let weakenedCount = 0;
    for (const file of changedTestFiles) {
      const head = input.readHeadFile(file);
      const current = input.readFile?.(file);
      if (head === undefined || current === undefined) continue; // new file or unreadable
      const changed = findChangedAssertions(head, current, file);
      if (changed.length === 0) continue;
      // The source file(s) under test: the test's relative imports, from both
      // versions (a removed import must not hide the link). No resolvable
      // import → any changed non-test file excuses the change.
      const imports = new Set<string>();
      for (const text of [head, current]) {
        for (const spec of analyzeSourceText(text, file).relativeImports) {
          const resolved = resolveTestImport(file, spec);
          if (resolved !== null) imports.add(resolved);
        }
      }
      const sourceUnderTestChanged =
        imports.size > 0
          ? [...imports].some((imp) => changedSourceModules.has(imp))
          : changedSourceFiles.length > 0;
      if (sourceUnderTestChanged) continue;
      weakenedCount += changed.length;
      for (const c of changed) {
        violations.push(
          c.after === null
            ? `removed test expectation in ${file}: "${c.testTitle}" ${c.matcher} expected ${c.before} — test expectations must not be removed without changing the source under test`
            : `weakened test expectation in ${file}: "${c.testTitle}" ${c.matcher} expected ${c.before} → ${c.after} with no change to the source under test`,
        );
      }
    }
    const testOnly = input.changedFiles.length > 0 && input.changedFiles.every(isTestFilePath);
    if (testOnly && weakenedCount > 0) {
      violations.push(
        `test-only diff rewrites ${weakenedCount} existing test expectation(s) without changing any source file — a fix must change source (adding new tests is allowed; changing existing expectations is not)`,
      );
    }
  }

  return { clean: violations.length === 0, violations, assertionCount, changedTestFiles };
}
