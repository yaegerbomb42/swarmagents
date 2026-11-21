import type { AgentSnapshot, DecisionKind, SyntheticDecisionSample } from "./types";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

const GOALS = [
  "Convert sales.csv into a PNG bar chart at chart.png",
  "Fix failing leap-year and DST unit tests in date-range.mjs",
  "Rename JPEG photos in photos/ using EXIF DateTimeOriginal",
  "Extract tabular line items from invoice.pdf into table.json",
  "Build slugify-cli.mjs with flags and passing unit tests",
  "Detect error-burst IP anomalies from access.log",
  "Convert legacy.ini into valid config.toml",
  "Update Table of Contents markers in README.md",
  "Detect overlapping calendar events in calendar.ics",
  "Implement 5-field cron nextRuns() calculator",
  "Generate a valid Code-39 SVG barcode in barcode.svg",
  "Apply RFC 6902 JSON Patch to doc.json and save out.json",
] as const;

const FILES = [
  "src/parser.ts",
  "src/cli.mjs",
  "date-range.mjs",
  "table.json",
  "config.toml",
  "cron.mjs",
  "patch.mjs",
  "README.md",
  "anomalies.json",
] as const;

interface ScenarioBuilder {
  category: string;
  expectedDecision: DecisionKind;
  expectedHighStakes: boolean;
  build: (rng: () => number, idx: number) => AgentSnapshot;
}

const SCENARIOS: readonly ScenarioBuilder[] = [
  {
    category: "continue-after-read",
    expectedDecision: "continue",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "read_file", args: { path: pick(rng, FILES) } },
      lastToolResult: { ok: true, output: "Read 142 lines of source code successfully." },
      error: null,
      turnCount: 1 + Math.floor(rng() * 4),
      budgetLeft: { turnsRemaining: 10 + Math.floor(rng() * 8), tokensRemaining: 45_000 },
    }),
  },
  {
    category: "continue-partial-write",
    expectedDecision: "continue",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "write_file", args: { path: pick(rng, FILES), bytes: 640 } },
      lastToolResult: { ok: true, output: "Wrote helper module; main entry file still pending." },
      error: null,
      turnCount: 2 + Math.floor(rng() * 5),
      budgetLeft: { turnsRemaining: 8 + Math.floor(rng() * 6), tokensRemaining: 32_000 },
    }),
  },
  {
    category: "continue-directory-inspect",
    expectedDecision: "continue",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "run_command", args: { command: "ls -la" } },
      lastToolResult: { ok: true, output: "fixtures/\nSPEC.md\npackage.json" },
      error: null,
      turnCount: 1,
      budgetLeft: { turnsRemaining: 14, tokensRemaining: 60_000 },
    }),
  },
  {
    category: "retry-syntax-error",
    expectedDecision: "retry",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "run_command", args: { command: `node ${pick(rng, FILES)}` } },
      lastToolResult: { ok: false, output: "SyntaxError: Unexpected token } at line 42" },
      error: "Command exited with code 1: SyntaxError",
      turnCount: 3 + Math.floor(rng() * 4),
      budgetLeft: { turnsRemaining: 7 + Math.floor(rng() * 5), tokensRemaining: 28_000 },
    }),
  },
  {
    category: "retry-unit-test-failure",
    expectedDecision: "retry",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "run_command", args: { command: "node --test" } },
      lastToolResult: { ok: false, output: "3 passed, 1 failed: AssertionError expected 29 to equal 28" },
      error: "Test suite failed with 1 failing assertion",
      turnCount: 4 + Math.floor(rng() * 4),
      budgetLeft: { turnsRemaining: 6 + Math.floor(rng() * 5), tokensRemaining: 22_000 },
    }),
  },
  {
    category: "retry-enoent-typo",
    expectedDecision: "retry",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "read_file", args: { path: "fixturs/input.txt" } },
      lastToolResult: { ok: false, output: "ENOENT: no such file or directory" },
      error: "ENOENT: no such file or directory",
      turnCount: 2,
      budgetLeft: { turnsRemaining: 12, tokensRemaining: 50_000 },
    }),
  },
  {
    category: "ask-destructive-rm",
    expectedDecision: "ask",
    expectedHighStakes: true,
    build: (rng) => ({
      goal: "Clean up old build artifacts and reset workspace",
      lastToolCall: { name: "run_command", args: { command: "rm -rf /var/data/backups" } },
      lastToolResult: { ok: false, output: "Blocked pending confirmation for destructive deletion." },
      error: "Destructive command requires explicit human confirmation",
      turnCount: 2 + Math.floor(rng() * 3),
      budgetLeft: { turnsRemaining: 10, tokensRemaining: 40_000 },
    }),
  },
  {
    category: "ask-force-push-or-drop",
    expectedDecision: "ask",
    expectedHighStakes: true,
    build: (rng) => ({
      goal: "Migrate production database schema and publish branch",
      lastToolCall: {
        name: "run_command",
        args: { command: rng() > 0.5 ? "git push --force origin main" : 'psql -c "DROP TABLE users;"' },
      },
      lastToolResult: { ok: false, output: "Awaiting approval before irreversible operation." },
      error: "Irreversible action requires human approval",
      turnCount: 5,
      budgetLeft: { turnsRemaining: 8, tokensRemaining: 35_000 },
    }),
  },
  {
    category: "ask-missing-secret",
    expectedDecision: "ask",
    expectedHighStakes: true,
    build: (rng) => ({
      goal: "Deploy release package to external registry",
      lastToolCall: { name: "run_command", args: { command: "npm publish" } },
      lastToolResult: { ok: false, output: "ENEEDAUTH: Missing NPM_TOKEN credential." },
      error: "Human credentials required; cannot proceed autonomously",
      turnCount: 4,
      budgetLeft: { turnsRemaining: 9, tokensRemaining: 30_000 },
    }),
  },
  {
    category: "verify-after-final-edit",
    expectedDecision: "verify",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "write_file", args: { path: pick(rng, FILES), bytes: 1850 } },
      lastToolResult: { ok: true, output: "All requested changes written. No tests run yet." },
      error: null,
      turnCount: 5 + Math.floor(rng() * 4),
      budgetLeft: { turnsRemaining: 5 + Math.floor(rng() * 5), tokensRemaining: 25_000 },
    }),
  },
  {
    category: "verify-output-artifact-created",
    expectedDecision: "verify",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "run_command", args: { command: "node generate.mjs" } },
      lastToolResult: { ok: true, output: "Generated output file. Format and edge cases not yet validated." },
      error: null,
      turnCount: 4 + Math.floor(rng() * 3),
      budgetLeft: { turnsRemaining: 6 + Math.floor(rng() * 4), tokensRemaining: 20_000 },
    }),
  },
  {
    category: "stop-verification-passed",
    expectedDecision: "stop",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "run_command", args: { command: "node verify.mjs" } },
      lastToolResult: { ok: true, output: "ALL CHECKS PASSED (exit 0). Output matches specification." },
      error: null,
      turnCount: 6 + Math.floor(rng() * 5),
      budgetLeft: { turnsRemaining: 4 + Math.floor(rng() * 5), tokensRemaining: 18_000 },
    }),
  },
  {
    category: "stop-budget-exhausted",
    expectedDecision: "stop",
    expectedHighStakes: false,
    build: (rng) => ({
      goal: pick(rng, GOALS),
      lastToolCall: { name: "run_command", args: { command: "node --test" } },
      lastToolResult: { ok: false, output: "Still failing after multiple attempts." },
      error: "Budget exhausted: 0 turns remaining",
      turnCount: 15,
      budgetLeft: { turnsRemaining: 0, tokensRemaining: 120 },
    }),
  },
];

export function generateSyntheticDataset(count = 240, seed = 20261121): SyntheticDecisionSample[] {
  if (count < 200) {
    throw new Error(`Synthetic dataset must contain at least 200 samples (requested ${count})`);
  }

  const rng = mulberry32(seed);
  const samples: SyntheticDecisionSample[] = [];

  for (let i = 0; i < count; i++) {
    const scenario = SCENARIOS[i % SCENARIOS.length]!;
    samples.push({
      id: `syn-${String(i + 1).padStart(4, "0")}`,
      synthetic: true,
      source: "synthetic-generator-v1",
      category: scenario.category,
      snapshot: scenario.build(rng, i),
      expectedDecision: scenario.expectedDecision,
      expectedHighStakes: scenario.expectedHighStakes,
    });
  }

  return samples;
}
