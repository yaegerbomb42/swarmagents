// Deterministic mock LLM replay driver.
//
// A real agent run is not deterministic, so the harness's CI mode replays
// scripted transcripts: per-task, per-profile turn/token numbers that are
// fixed by a hash of the task id (same task + profile always replays the
// same usage). What the driver *does* is real: it materialises the fixture,
// applies the scripted fix at the scripted turn through a small tool shim,
// performs the scripted failing tool calls for real (reads of missing
// paths, counted as observed errors), and grades by actually running the
// fixture tests in the isolated directory. Token counts are replayed, not
// measured — that is the point of a replay driver. A future live driver
// implements the same AgentDriver interface against the real harness.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  EvalBucket,
  EvalRunMetrics,
  EvalTaskDef,
  EvalTranscript,
  HarnessConfig,
} from "./types";
import { TOKEN_PRICES_USD_PER_MILLION } from "./types";

const execFileAsync = promisify(execFile);

export interface AgentDriver {
  run(
    task: EvalTaskDef,
    config: HarnessConfig,
    runDir: string
  ): Promise<{ metrics: EvalRunMetrics; grading: GradingResult }>;
}

export interface GradingResult {
  passed: number;
  failed: number;
  total: number;
}

/** FNV-1a hash, for deterministic per-task jitter. */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small deterministic PRNG for the bootstrap. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer in [min, max] from a seed. */
export function jitter(seed: number, min: number, max: number): number {
  const rand = mulberry32(seed);
  return min + Math.floor(rand() * (max - min + 1));
}

interface BucketProfile {
  inputPerTurn: number;
  outputPerTurn: number;
  cachedFrac: number;
  toolCallsPerTurn: number;
}

const BUCKET_PROFILES: Record<EvalBucket, BucketProfile> = {
  surgical: { inputPerTurn: 1400, outputPerTurn: 350, cachedFrac: 0.6, toolCallsPerTurn: 3 },
  feature: { inputPerTurn: 1600, outputPerTurn: 450, cachedFrac: 0.55, toolCallsPerTurn: 4 },
  "long-horizon": { inputPerTurn: 1800, outputPerTurn: 550, cachedFrac: 0.5, toolCallsPerTurn: 5 },
};

/**
 * Scripted behaviour for one task under one profile. Deterministic: the
 * same task id + profile always yields the same transcript.
 *
 * Baseline turns scale with the task's own turn target (never above it).
 * The wasteful profile is derived from the baseline transcript for the
 * same task (never drawn independently), so its burn is guaranteed above
 * baseline's — an independent draw could land below baseline and hide the
 * regression the profile exists to demonstrate.
 *
 * - baseline: the config under test behaves well — solves the task with
 *   prefix-cache-friendly usage.
 * - wasteful: same solve, ~1.7x turns, ~1.9x input tokens, ~5% cache hits
 *   (no prefix stability, verbose re-reads) — a token regression.
 * - broken: the run applies a plausible-but-wrong fix and fails grading.
 */
export function transcriptFor(task: EvalTaskDef, profile: HarnessConfig["profile"]): EvalTranscript {
  const base = BUCKET_PROFILES[task.bucket];
  const seed = hashSeed(task.id + ":" + profile);
  if (profile === "wasteful") {
    const baseline = transcriptFor(task, "baseline");
    const wastefulTurns = Math.round(baseline.turns * 1.7);
    return {
      turns: wastefulTurns,
      inputTokens: Math.round(baseline.inputTokens * 1.9),
      outputTokens: Math.round(baseline.outputTokens * 1.4),
      cachedInputTokens: Math.round(baseline.inputTokens * 1.9 * 0.05),
      toolCalls: wastefulTurns * (base.toolCallsPerTurn + 2),
      toolErrors: baseline.toolErrors + 3 + jitter(seed + 3, 0, 2),
      rewinds: 1,
      apply: "solution",
    };
  }
  const minTurns = Math.max(4, Math.round(task.targetTurns * 0.7));
  const turns = jitter(seed, minTurns, task.targetTurns);
  const inputTokens = Math.round(turns * base.inputPerTurn * (0.9 + mulberry32(seed + 1)() * 0.2));
  const outputTokens = Math.round(turns * base.outputPerTurn * (0.9 + mulberry32(seed + 2)() * 0.2));
  const toolErrors = jitter(seed + 3, 0, 1);
  if (profile === "broken") {
    return {
      turns,
      inputTokens,
      outputTokens,
      cachedInputTokens: Math.round(inputTokens * base.cachedFrac),
      toolCalls: turns * base.toolCallsPerTurn,
      toolErrors,
      rewinds: 0,
      apply: "broken",
    };
  }
  return {
    turns,
    inputTokens,
    outputTokens,
    cachedInputTokens: Math.round(inputTokens * base.cachedFrac),
    toolCalls: turns * base.toolCallsPerTurn,
    toolErrors,
    rewinds: 0,
    apply: "solution",
  };
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  modelTier: "strong" | "cheap"
): number {
  const prices = TOKEN_PRICES_USD_PER_MILLION[modelTier];
  return (
    (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000
  );
}

/** Parse TAP output: count top-level `ok N` / `not ok N` result lines. */
export function parseTap(output: string): GradingResult {
  let passed = 0;
  let failed = 0;
  for (const line of output.split("\n")) {
    if (/^ok \d/.test(line)) passed++;
    else if (/^not ok \d/.test(line)) failed++;
  }
  return { passed, failed, total: passed + failed };
}

/** Grade a run directory by running its fixture tests with node --test. */
export async function gradeRunDir(
  runDir: string,
  testPath: string
): Promise<GradingResult> {
  const absolute = path.join(runDir, testPath);
  // Node's test runner refuses to run `node --test` from inside a test
  // file ("run() is being called recursively ... skipping running files")
  // when it sees NODE_TEST_CONTEXT in the environment — the child exits 0
  // with empty stdout. Grading must work both from the CLI and from
  // inside `tsx --test`, so strip the runner's markers from the child env.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--test", "--test-reporter=tap", absolute],
      // Generous timeout: under a parallel test run the machine is
      // saturated and a grading subprocess can take far longer than the
      // ~1s it needs unloaded. A timeout here fails a trial, which the
      // baseline-vs-baseline gate reads as a regression.
      { cwd: runDir, timeout: 120_000, maxBuffer: 1024 * 1024, env }
    );
    return parseTap(stdout);
  } catch (err) {
    const stdout =
      err instanceof Error && "stdout" in err
        ? String((err as { stdout?: unknown }).stdout ?? "")
        : "";
    const parsed = parseTap(stdout);
    // A failing test file exits non-zero but still emits TAP; a crash that
    // emits no TAP is a grading failure of everything.
    if (parsed.total === 0) {
      return { passed: 0, failed: 1, total: 1 };
    }
    return parsed;
  }
}

async function writeFiles(
  runDir: string,
  files: Record<string, string>
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(runDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

export class MockReplayDriver implements AgentDriver {
  async run(
    task: EvalTaskDef,
    config: HarnessConfig,
    runDir: string
  ): Promise<{ metrics: EvalRunMetrics; grading: GradingResult }> {
    const started = Date.now();
    const transcript = transcriptFor(task, config.profile);

    await writeFiles(runDir, task.files);
    await writeFiles(runDir, { [task.test.path]: task.test.content });

    // Replay the scripted turns. The fix lands at the scripted turn; the
    // scripted failing tool calls are performed for real (reads of paths
    // that do not exist) so toolErrorRate is observed, not asserted.
    const applyTurn = transcript.applyTurn ?? transcript.turns;
    let observedToolErrors = 0;
    let remainingErrors = transcript.toolErrors;
    for (let turn = 1; turn <= transcript.turns; turn++) {
      if (turn === applyTurn) {
        const patch =
          transcript.apply === "solution"
            ? task.solution
            : transcript.apply === "broken"
              ? task.broken
              : {};
        await writeFiles(runDir, patch);
      }
      if (remainingErrors > 0) {
        try {
          await readFile(path.join(runDir, `src/__missing_${turn}.mjs`), "utf8");
        } catch {
          observedToolErrors++;
          remainingErrors--;
        }
      }
    }

    const grading = await gradeRunDir(runDir, task.test.path);
    const resolved = grading.total > 0 && grading.failed === 0;
    const partialScore = grading.total === 0 ? 0 : grading.passed / grading.total;

    const totalInputTokens = transcript.inputTokens;
    const totalOutputTokens = transcript.outputTokens;
    const metrics: EvalRunMetrics = {
      resolved,
      partialScore,
      totalTurns: transcript.turns,
      totalInputTokens,
      cachedInputTokens: transcript.cachedInputTokens,
      totalOutputTokens,
      estimatedUsdCost: estimateCostUsd(totalInputTokens, totalOutputTokens, config.modelTier),
      wallClockMs: Date.now() - started,
      rewindsTriggered: transcript.rewinds,
      cacheHitRate:
        totalInputTokens === 0 ? 0 : transcript.cachedInputTokens / totalInputTokens,
      toolErrorRate:
        transcript.toolCalls === 0 ? 0 : observedToolErrors / transcript.toolCalls,
    };
    return { metrics, grading };
  }
}
