/**
 * Gate ratchet, flaky-test quarantine, and multi-language anti-cheat checks.
 *
 * Ported from vendor/omnexx/src/verify/{ratchet.ts,flaky.ts,anticheat.ts} with
 * zero host-fs or omnexx-specific dependencies.
 */

import { matchesDenylist } from "./diff-hygiene";
import type { Failure, TestCounts } from "./parsers";

export type GateLevel = "must-pass" | "ratchet";

export interface GateConfig {
  name: string;
  level?: GateLevel;
  flakyReruns?: number;
}

export interface GateResult {
  name: string;
  level: GateLevel;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  failures: Failure[];
  tests?: TestCounts;
  structured: boolean;
  logFile?: string;
}

export interface GateBaselineEntry {
  exitCode: number;
  failureIds: readonly string[];
  tests?: TestCounts;
}

export type GateBaseline = Readonly<Record<string, GateBaselineEntry>>;

export interface GateVerdict {
  gate: string;
  pass: boolean;
  reason?: string;
  newFailures: string[];
  fixed: string[];
}

export interface FlakyFinding {
  gate: string;
  ids: string[];
}

/**
 * `must-pass`: exit 0 and no timeout.
 * `ratchet`: no failure id that wasn't already failing at baseline, and total
 * failures cannot grow. Missing baseline falls back to `must-pass`.
 */
export function judgeGate(result: GateResult, baseline: GateBaseline | undefined): GateVerdict {
  const base = baseline?.[result.name];
  const ids = result.failures.map((f) => f.id);
  const baseIds = new Set(base?.failureIds ?? []);
  const newFailures = [...new Set(ids.filter((id) => !baseIds.has(id)))];
  const currentIds = new Set(ids);
  const fixed = [...baseIds].filter((id) => !currentIds.has(id));
  const verdict = (pass: boolean, reason?: string): GateVerdict => ({
    gate: result.name,
    pass,
    ...(reason ? { reason } : {}),
    newFailures,
    fixed,
  });

  if (result.timedOut) return verdict(false, "timed out");
  if (result.level === "must-pass" || !base) {
    return result.exitCode === 0 ? verdict(true) : verdict(false, `exit ${result.exitCode}`);
  }
  if (result.exitCode !== 0 && base.exitCode === 0) {
    return verdict(false, `exit ${result.exitCode}; passed at baseline`);
  }
  if (newFailures.length) return verdict(false, `${newFailures.length} new failure(s)`);
  if (ids.length > base.failureIds.length) {
    return verdict(false, `failures rose from ${base.failureIds.length} to ${ids.length}`);
  }
  return verdict(true);
}

/** Normalized failure signature independent of line numbers, SHAs, hex addresses, and timings. */
export function failureSignature(parts: readonly string[]): string {
  return parts
    .map((p) =>
      p
        .replace(/0x[0-9a-f]+/gi, "0x#")
        .replace(/\b[0-9a-f]{7,40}\b/gi, "#sha")
        .replace(/\d+(\.\d+)?\s*(ms|s)\b/g, "#t")
        .replace(/:\d+(:\d+)?/g, ":#")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .sort()
    .join(" | ");
}

/**
 * Run each gate via `runGate`; when a gate has new structured failures, re-run
 * it up to `gate.flakyReruns` times. Failures that disappear on a re-run are
 * reported as `flaky` and do not fail the verdict.
 */
export async function runGatesWithFlakyCheck<TGate extends GateConfig>(
  gates: readonly TGate[],
  runGate: (gate: TGate, rerunIndex: number) => Promise<GateResult>,
  baseline: GateBaseline | undefined,
  knownFlaky: ReadonlySet<string> = new Set(),
  firstRuns: ReadonlyMap<string, GateResult> = new Map(),
): Promise<{ results: GateResult[]; flaky: FlakyFinding[]; reruns: number }> {
  const results: GateResult[] = [];
  const flaky: FlakyFinding[] = [];
  let reruns = 0;

  for (const gate of gates) {
    let result = firstRuns.get(gate.name) ?? (await runGate(gate, 0));
    const maxReruns = Math.max(0, gate.flakyReruns ?? 0);
    const seenNew = new Set<string>();

    for (let i = 1; i <= maxReruns; i++) {
      const v = judgeGate(result, baseline);
      const fresh = v.newFailures.filter((id) => !knownFlaky.has(id));
      if (v.pass || result.timedOut || !result.structured || fresh.length === 0) break;
      for (const id of v.newFailures) seenNew.add(id);
      result = await runGate(gate, i);
      reruns++;
    }

    const stillFailing = new Set(result.failures.map((f) => f.id));
    const quarantined = [...seenNew].filter((id) => !stillFailing.has(id));
    if (quarantined.length > 0) flaky.push({ gate: gate.name, ids: quarantined });
    results.push(result);
  }

  return { results, flaky, reruns };
}

// ---------------------------------------------------------------------------
// Multi-language anti-cheat checks
// ---------------------------------------------------------------------------

export const ANTI_CHEAT_TEST_PATTERNS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.go",
  "**/test_*.py",
  "**/*_test.py",
  "test/**",
  "tests/**",
  "**/__tests__/**",
];

const GENERATED_OR_VENDORED: readonly string[] = [
  "node_modules/**",
  "**/node_modules/**",
  "vendor/**",
  "**/vendor/**",
  "coverage/**",
  "**/coverage/**",
  ".nyc_output/**",
  "**/.nyc_output/**",
];

const SKIP_DIRECTIVE_MARKERS: readonly [RegExp, string][] = [
  [/\b(it|test|describe|suite|context)\.(skip|only|todo)\b/, ".skip/.only"],
  [/\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/, "x/f-prefixed test"],
  [/\{\s*skip\s*:\s*(true|['"])/, "node:test skip option"],
  [/\bt\.skip\s*\(/, "t.skip()"],
  [/@pytest\.mark\.(skip|xfail)/, "@pytest.mark.skip"],
  [/\bpytest\.skip\s*\(/, "pytest.skip()"],
  [/\bunittest\.skip/, "unittest.skip"],
  [/(\/\/|\/\*)\s*@ts-(ignore|nocheck|expect-error)\b/, "@ts-ignore"],
  [/(\/\/|\/\*)\s*eslint-disable/, "eslint-disable"],
  [/#\s*type:\s*ignore/, "type: ignore"],
  [/#\s*noqa\b/, "noqa"],
  [/\bt\.Skip(Now|f)?\s*\(/, "go t.Skip"],
];

function stripStringLiterals(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function isNonProjectPath(filePath: string): boolean {
  return matchesDenylist(filePath, GENERATED_OR_VENDORED) !== undefined;
}

const stem = (p: string): string => p.replace(/\.[^./]+$/, "");

function portedTestPaths(
  changes: readonly AntiCheatChange[],
  isTest: (p: string) => boolean,
): Set<string> {
  const added = new Set(
    changes.filter((c) => c.status === "A" && isTest(c.path)).map((c) => stem(c.path)),
  );
  return new Set(
    changes.filter((c) => c.status === "D" && added.has(stem(c.path))).map((c) => c.path),
  );
}

export interface AntiCheatChange {
  path: string;
  status: "A" | "M" | "D" | "R";
  oldPath?: string;
}

export interface AntiCheatViolation {
  rule: "deleted-test" | "test-count-drop" | "skip-marker" | "snapshot-rewrite" | "protected-path";
  detail: string;
}

export interface AntiCheatInput {
  changes: readonly AntiCheatChange[];
  patch: string;
  protectedPatterns?: readonly string[];
  allow?: readonly string[];
  baseline?: GateBaseline;
  results?: readonly GateResult[];
  /** When "general", only protected-path rules apply. Defaults to "swe". */
  domain?: "swe" | "general";
}

/**
 * Detect test-weakening and suppression shortcuts across TS/JS, Python, and Go
 * diffs (deleted tests, test-count drops, skip/ignore markers, snapshot rewrites,
 * and protected path edits).
 */
export function checkAntiCheat(input: AntiCheatInput): AntiCheatViolation[] {
  const allow = new Set(input.allow ?? []);
  const out: AntiCheatViolation[] = [];
  const isTest = (p: string): boolean => matchesDenylist(p, ANTI_CHEAT_TEST_PATTERNS) !== undefined;
  const swe = input.domain !== "general";

  const own = input.changes.filter(
    (c) => !isNonProjectPath(c.path) && (c.oldPath === undefined || !isNonProjectPath(c.oldPath)),
  );

  if (swe && !allow.has("delete-tests")) {
    const ported = portedTestPaths(own, isTest);
    for (const c of own) {
      if (c.status === "D" && isTest(c.path) && !ported.has(c.path)) {
        out.push({ rule: "deleted-test", detail: c.path });
      }
      if (c.status === "R" && c.oldPath && isTest(c.oldPath) && !isTest(c.path)) {
        out.push({ rule: "deleted-test", detail: `${c.oldPath} renamed to non-test ${c.path}` });
      }
    }
    for (const r of input.results ?? []) {
      const before = input.baseline?.[r.name]?.tests?.total;
      const now = r.tests?.total;
      if (before !== undefined && now !== undefined && now < before) {
        out.push({ rule: "test-count-drop", detail: `${r.name}: ${before} → ${now} tests` });
      }
    }
  }

  if (swe && !allow.has("skip")) {
    let file = "";
    for (const line of input.patch.split("\n")) {
      if (line.startsWith("+++ ")) {
        file = line.slice(4).replace(/^b\//, "").trim();
        continue;
      }
      if (!line.startsWith("+") || line.startsWith("+++") || isNonProjectPath(file)) continue;
      const cleaned = stripStringLiterals(line);
      for (const [re, label] of SKIP_DIRECTIVE_MARKERS) {
        if (re.test(cleaned)) {
          out.push({
            rule: "skip-marker",
            detail: `${label} added in ${file}: ${line.slice(1).trim().slice(0, 120)}`,
          });
          break;
        }
      }
    }
  }

  if (swe && !allow.has("snapshots")) {
    for (const c of own) {
      if (c.status !== "A" && (c.path.endsWith(".snap") || c.path.includes("__snapshots__/"))) {
        out.push({ rule: "snapshot-rewrite", detail: c.path });
      }
    }
  }

  if (!allow.has("protected") && input.protectedPatterns?.length) {
    for (const c of input.changes) {
      for (const p of [c.path, c.oldPath].filter((x): x is string => x !== undefined)) {
        const hit = matchesDenylist(p, input.protectedPatterns);
        if (hit) out.push({ rule: "protected-path", detail: `${p} (matches "${hit}")` });
      }
    }
  }

  return out;
}
