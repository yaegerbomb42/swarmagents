// Harness A/B evaluation types.
//
// The harness benchmarks *harness configurations* (prompt packing, cache
// behaviour, code mode, model tier, ...) end to end on agent tasks, and
// gates regressions with a Pareto rule. This is distinct from
// lib/capability-atlas/eval, which benchmarks capability *retrieval*
// accuracy (which tool a query maps to) — that eval stays as-is.

export type EvalBucket = "surgical" | "feature" | "long-horizon";

/** Which scripted behaviour a config replays under the mock driver. */
export type EvalProfile = "baseline" | "wasteful" | "broken";

/** A harness configuration under test. */
export interface HarnessConfig {
  /** Human-readable name, e.g. "main" or "pr-123-cache-on". */
  name: string;
  /** Scripted behaviour the mock replay driver replays for this config. */
  profile: EvalProfile;
  /** Model tier the config runs on; drives the USD cost estimate. */
  modelTier: "strong" | "cheap";
  /** Free-form knobs the config sets (compaction threshold, code mode, ...). */
  knobs?: Record<string, string | number | boolean>;
}

/**
 * One benchmark task. The starting code is materialised into an isolated
 * directory, the driver works in it, and grading runs the fixture tests.
 *
 * `repoCommit` is the pinned commit the task is reproducible from. Suite v1
 * tasks are self-contained fixtures (no network, no external MCPs); the
 * field is recorded in every report so a future repo-pinned task can be
 * checked out at exactly this commit by the isolation driver.
 */
export interface EvalTaskDef {
  id: string;
  bucket: EvalBucket;
  title: string;
  /** Turn budget the task is designed for (surgical <= 15, feature <= 80). */
  targetTurns: number;
  /** Pinned git commit the task reproduces from. */
  repoCommit: string;
  description: string;
  /** Starting code, path -> content, relative to the run dir. */
  files: Record<string, string>;
  /** Grading test file. */
  test: { path: string; content: string };
  /** The correct fix / implementation, path -> full file content. */
  solution: Record<string, string>;
  /** A plausible-but-wrong fix: grading must fail with it applied. */
  broken: Record<string, string>;
}

/** Deterministic scripted behaviour for one task under one profile. */
export interface EvalTranscript {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Total tool calls the scripted run makes. */
  toolCalls: number;
  /** Tool calls that error (the driver really performs them and counts). */
  toolErrors: number;
  /** Watchdog rewinds the scripted run triggers. */
  rewinds: number;
  /** What the run leaves on disk when it finishes. */
  apply: "solution" | "broken" | "none";
  /** 1-based turn on which the fix is applied (default: last turn). */
  applyTurn?: number;
}

export interface EvalRunMetrics {
  resolved: boolean;
  /** Fraction of grading assertions passing, 0-1. */
  partialScore: number;
  totalTurns: number;
  totalInputTokens: number;
  cachedInputTokens: number;
  totalOutputTokens: number;
  estimatedUsdCost: number;
  wallClockMs: number;
  rewindsTriggered: number;
  /** cachedInputTokens / totalInputTokens, 0 when no input tokens. */
  cacheHitRate: number;
  /** Failed tool calls / total tool calls, 0 when no calls. */
  toolErrorRate: number;
}

export interface EvalTrialResult {
  taskId: string;
  bucket: EvalBucket;
  configName: string;
  trial: number;
  metrics: EvalRunMetrics;
  /** Grading detail, for debugging a failed run. */
  grading: { passed: number; failed: number; total: number };
}

export interface EvalTaskAggregate {
  taskId: string;
  bucket: EvalBucket;
  trials: number;
  /** pass@1: fraction of trials resolved. */
  passRate: number;
  meanTotalTokens: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanCostUsd: number;
  meanTurns: number;
  p50Turns: number;
  p95Turns: number;
  meanCacheHitRate: number;
  meanToolErrorRate: number;
}

export interface EvalReport {
  configName: string;
  profile: EvalProfile;
  modelTier: "strong" | "cheap";
  trialsPerTask: number;
  tasksRun: number;
  /** Overall solve rate across all trials. */
  solveRate: number;
  meanTotalTokens: number;
  meanCostUsd: number;
  meanTurns: number;
  byBucket: Record<EvalBucket, { tasks: number; solveRate: number; meanTotalTokens: number; meanTurns: number }>;
  perTask: EvalTaskAggregate[];
  /** Bootstrap 95% CI for the solve rate (task-level resampling). */
  solveRateCi95: [number, number];
  generatedAt: string;
}

export interface ParetoComparison {
  baseline: string;
  candidate: string;
  solveRateDelta: number;
  /** Candidate minus baseline, as a fraction of baseline solve rate. */
  solveRateDrop: number;
  tokenDeltaFrac: number;
  /** 95% CI on (candidate - baseline) solve rate; excludes 0 => significant. */
  solveRateDiffCi95: [number, number];
  significantSolveGain: boolean;
  regression: boolean;
  reasons: string[];
  perBucket: Array<{
    bucket: EvalBucket;
    solveRateDelta: number;
    tokenDeltaFrac: number;
  }>;
}

/** Approximate list prices per 1M tokens; overridable by callers. */
export const TOKEN_PRICES_USD_PER_MILLION = {
  strong: { input: 3, output: 15 },
  cheap: { input: 0.5, output: 1.5 },
} as const;

/** Regression thresholds from the task spec. */
export const PARETO_SOLVE_RATE_DROP_MAX = 0.02;
export const PARETO_TOKEN_RISE_MAX = 0.15;
