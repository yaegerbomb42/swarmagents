export interface TestsSlashCommand {
  kind: "tests";
  /** Target file/feature path as provided. */
  target: string;
  /** Optional max iterations (default 3). */
  maxIterations?: number;
}

export type ParsedSlashCommand = TestsSlashCommand | null;

/**
 * Parse composer slash commands. Currently supports:
 *   /tests <path> [--max=N]
 */
export function parseSlashCommand(input: string): ParsedSlashCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  if (cmd !== "/tests") return null;
  let target = "";
  let maxIterations: number | undefined;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const m = p.match(/^--max=(\d+)$/i);
    if (m) {
      maxIterations = Math.max(1, Math.min(10, Number(m[1])));
      continue;
    }
    if (!target) target = p;
    else target += " " + p; // tolerate spaces (quoted not required but keep rest)
  }
  target = target.trim();
  if (!target) return { kind: "tests", target: "", maxIterations };
  return { kind: "tests", target, maxIterations };
}

export function formatTestsPrompt(target: string, maxIterations = 3): string {
  return [
    `Use the Test Writer workflow for \`${target}\`.`,
    `1. Detect the test framework for this repo/path (vitest, jest, node:test, pytest, or go test) by inspecting configs and dependencies.`,
    `2. Generate focused tests for the target covering observable behavior, happy path, edge cases, and failure modes. Do not test implementation details.`,
    `3. Run the tests for the area you touched.`,
    `4. If tests fail, iterate to fix the tests or the code as appropriate, up to ${maxIterations} attempts total. Never weaken assertions just to make tests pass; if you suspect a real bug in existing behavior, flag it clearly instead of masking it.`,
    `5. Run coverage using the framework's standard tool (c8/istanbul for JS node:test/jest/vitest, pytest-cov for pytest, go test -cover for Go).`,
    `6. Emit a coverage.report telemetry event with JSON data: { "framework": string, "linesPct": number|null, "files": [{"path":string,"linesPct":number|null,"uncovered":string[]}], "uncoveredRanges": string[] }. Also summarize results and any suspected real bugs.`,
  ].join("\n");
}
