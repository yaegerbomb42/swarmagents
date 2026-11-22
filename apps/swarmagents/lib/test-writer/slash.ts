export interface TestsSlashCommand {
  kind: "tests";
  /** Target file/feature path as provided. */
  target: string;
  /** Optional max iterations (default 3). */
  maxIterations?: number;
}

export type ParsedSlashCommand = TestsSlashCommand | null;

/** Longest target interpolated into a Test Writer prompt; longer targets are truncated so a pasted blob cannot bloat the prompt. */
export const MAX_TESTS_TARGET_LENGTH = 500;

/** Tokenize on whitespace while respecting single/double quotes. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseMaxValue(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Math.min(10, Number(raw)));
}

/**
 * Parse composer slash commands. Currently supports:
 *   /tests <path> [--max=N | --max N]
 * Quoted paths with spaces are supported. Unknown --flags are ignored.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = tokenize(trimmed);
  const cmd = (parts[0] ?? "").toLowerCase();
  if (cmd !== "/tests") return null;

  let target = "";
  let maxIterations: number | undefined;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const eq = p.match(/^--max=(\d+)$/i);
    if (eq) {
      maxIterations = parseMaxValue(eq[1]);
      continue;
    }
    if (/^--max$/i.test(p)) {
      const next = parts[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        maxIterations = parseMaxValue(next);
        i += 1;
      }
      continue;
    }
    if (p.startsWith("-")) {
      // Unknown flag: ignore (do not concatenate onto target).
      continue;
    }
    if (!target) target = p;
    else target += " " + p;
  }
  target = target.trim();
  if (!target) return { kind: "tests", target: "", maxIterations };
  return { kind: "tests", target, maxIterations };
}

/** Sanitize a path/feature for interpolation into the Test Writer prompt. */
export function sanitizeTestsTarget(target: string): string {
  return target
    .replace(/[`\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatTestsPrompt(target: string, maxIterations = 3): string {
  const safe = sanitizeTestsTarget(target);
  const shown =
    safe.length > MAX_TESTS_TARGET_LENGTH
      ? `${safe.slice(0, MAX_TESTS_TARGET_LENGTH)}…`
      : safe;
  const label = shown ? `\`${shown}\`` : "the selected target";
  return [
    `Use the Test Writer workflow for ${label}.`,
    `1. Detect the test framework for this repo/path (vitest, jest, node:test, pytest, or go test) by inspecting configs and dependencies.`,
    `2. Generate focused tests for the target covering observable behavior, happy path, edge cases, and failure modes. Do not test implementation details.`,
    `3. Run the tests for the area you touched.`,
    `4. If tests fail, iterate to fix the tests or the code as appropriate, up to ${maxIterations} attempts total. Never weaken assertions just to make tests pass; if you suspect a real bug in existing behavior, flag it clearly instead of masking it.`,
    `5. Run coverage using the framework's standard tool (c8/istanbul for JS node:test/jest/vitest, pytest-cov for pytest, go test -cover for Go).`,
    `6. Emit a coverage.report telemetry event with JSON data: { "framework": string, "linesPct": number|null, "files": [{"path":string,"linesPct":number|null,"uncovered":string[]}], "uncoveredRanges": string[] }. Also summarize results and any suspected real bugs.`,
  ].join("\n");
}
