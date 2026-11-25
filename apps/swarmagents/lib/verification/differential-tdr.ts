/**
 * 3-Way Differential Test-Driven Matrix Orchestrator & 4-Way Gate Evaluator.
 *
 * Ported from vendor/omnexx/src/verify/differential-tdr.ts and adapted to run
 * strictly inside the VM via SwarmAgents' injected `ShadowExec` channel (no
 * host filesystem access or execa).
 *
 * Verifies a candidate patch against a baseline commit:
 *   1. Pre-patch repro run on baseline -> must FAIL (`reject_repro` if it passes or times out).
 *   2. Post-patch repro run on patched worktree -> must PASS (`reject_fix` if patch fails to apply or fails).
 *   3. Regression comparison between baseline and patched worktrees -> new failures trigger
 *      `reject_regression` (after optional `flakyReruns` quarantine).
 */

import { randomUUID } from "node:crypto";
import { posix as path } from "node:path";
import { execWithTimeout, writeFileViaExec } from "../harness/oracle/exec";
import { parseGateOutput, type Failure, type GateParser, type TestCounts } from "./parsers";
import type { ShadowExec } from "./shadow-verifier";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PARSER: GateParser = "vitest";
const DEFAULT_BIN = "npx vitest";

export type RejectReproReason = "passed-on-baseline" | "timed-out-on-baseline";
export type RejectFixReason = "failed-after-patch" | "patch-did-not-apply";

export type DifferentialVerdict =
  | { status: "pass" }
  | { status: "reject_repro"; reason: RejectReproReason }
  | { status: "reject_fix"; reason: RejectFixReason }
  | { status: "reject_regression" };

export interface RegressionFailure {
  id: string;
  message: string;
}

export interface DifferentialRun {
  label: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  failures: Failure[];
  tests?: TestCounts;
}

export type DifferentialRunKey =
  | "prePatch"
  | "postPatch"
  | "regressionBaseline"
  | "regressionPatched";

export interface DifferentialMatrixResult {
  verdict: DifferentialVerdict;
  baseSha: string;
  reproTestPath: string;
  runs: Readonly<Partial<Record<DifferentialRunKey, DifferentialRun>>>;
  regressions: readonly RegressionFailure[];
  flaky: readonly RegressionFailure[];
}

export interface DifferentialMatrixOptions {
  repoRoot: string;
  baseSha: string;
  candidateDiff: string;
  reproTestPath: string;
  /** Parent folder inside the VM for transient worktrees. Default `${repoRoot}/../.tdr-worktrees`. */
  worktreeRoot?: string;
  /** Repo-relative dirs to symlink into each transient worktree (e.g. `["node_modules"]`). */
  linkDirs?: readonly string[];
  /** Output parser for the test suite. Default `"vitest"`. */
  parser?: GateParser;
  /** Per-run timeout in ms. Default 60s. */
  timeoutMs?: number;
  /** Override repro argv command. Default `[...binParts, "run", reproTestPath, "--reporter=json"]`. */
  reproCommand?: readonly string[];
  /** Override regression argv command. Default `[...binParts, "run", "--reporter=json"]`. */
  regressionCommand?: readonly string[];
  /** Base binary tokens when building default vitest commands. Default `"npx vitest"`. */
  regressionBin?: string;
  /** Number of re-runs on patched regression failures for flaky quarantine. Default 0. */
  flakyReruns?: number;
  signal?: AbortSignal;
  redact?: (s: string) => string;
}

function assertValidBaseSha(baseSha: string): void {
  const trimmed = baseSha.trim();
  if (!trimmed || trimmed.startsWith("-") || !/^[A-Za-z0-9._/-]{4,128}$/.test(trimmed)) {
    throw new TypeError("baseSha must be a valid git ref or commit SHA");
  }
}

function assertRelativeWithinRoot(reproTestPath: string): void {
  if (typeof reproTestPath !== "string" || !reproTestPath) {
    throw new TypeError("reproTestPath must be a non-empty string");
  }
  if (path.isAbsolute(reproTestPath)) {
    throw new TypeError("reproTestPath must be relative to the repo root");
  }
  const normalized = path.normalize(reproTestPath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized) || normalized.startsWith("-")) {
    throw new TypeError("reproTestPath escapes the repo root");
  }
}

function computeRegressions(baseline: DifferentialRun, patched: DifferentialRun): RegressionFailure[] {
  const baselineIds = new Set(baseline.failures.map((f) => f.id));
  return patched.failures
    .filter((f) => !baselineIds.has(f.id))
    .map((f) => ({ id: f.id, message: f.message }));
}

export async function runDifferentialMatrix(
  exec: ShadowExec,
  options: DifferentialMatrixOptions,
): Promise<DifferentialMatrixResult> {
  const repoRoot = options.repoRoot.replace(/\/+$/, "");
  if (!repoRoot) throw new TypeError("repoRoot is required");
  assertValidBaseSha(options.baseSha);
  if (typeof options.candidateDiff !== "string") {
    throw new TypeError("candidateDiff must be a string");
  }
  assertRelativeWithinRoot(options.reproTestPath);

  const parser = options.parser ?? DEFAULT_PARSER;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const redact = options.redact ?? ((s: string): string => s);
  const binParts = (options.regressionBin ?? DEFAULT_BIN).trim().split(/\s+/).filter(Boolean);
  const flakyReruns = Math.max(0, options.flakyReruns ?? 0);
  const wtParent = (options.worktreeRoot ?? path.join(path.dirname(repoRoot), ".tdr-worktrees")).replace(
    /\/+$/,
    "",
  );

  const reproCmd = options.reproCommand
    ? [...options.reproCommand]
    : [...binParts, "run", options.reproTestPath, "--reporter=json"];
  const regressionCmd = options.regressionCommand
    ? [...options.regressionCommand]
    : [...binParts, "run", "--reporter=json"];

  const createdWorktrees: string[] = [];

  const createWorktree = async (tag: string): Promise<string> => {
    const wtDir = path.join(wtParent, `tdr-${tag}-${randomUUID()}`);
    await exec(["mkdir", "-p", wtParent], { signal: options.signal });
    const added = await exec(
      ["git", "-C", repoRoot, "worktree", "add", "--detach", "--quiet", wtDir, options.baseSha],
      { signal: options.signal },
    );
    if (added.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${redact(added.stderr.trim())}`);
    }
    createdWorktrees.push(wtDir);
    for (const rel of options.linkDirs ?? []) {
      const src = path.join(repoRoot, rel);
      const exists = await exec(["test", "-e", src], { signal: options.signal });
      if (exists.exitCode !== 0) continue;
      const dst = path.join(wtDir, rel);
      await exec(["mkdir", "-p", path.dirname(dst)], { signal: options.signal });
      await exec(["ln", "-sfn", src, dst], { signal: options.signal });
    }
    return wtDir;
  };

  const applyPatchInWorktree = async (wtDir: string, diff: string): Promise<boolean> => {
    const patchFile = path.join(wtDir, `.swarm-tdr-${randomUUID()}.patch`);
    try {
      await writeFileViaExec(exec, patchFile, diff);
      const res = await exec(["git", "-C", wtDir, "apply", "--whitespace=nowarn", patchFile], {
        signal: options.signal,
      });
      return res.exitCode === 0;
    } finally {
      await exec(["rm", "-f", patchFile]).catch(() => undefined);
    }
  };

  const runSuite = async (cwd: string, cmd: string[], label: string): Promise<DifferentialRun> => {
    const started = Date.now();
    const res = await execWithTimeout(exec, cmd, {
      cwd,
      timeoutMs,
      signal: options.signal,
    });
    const combined = redact(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`);
    const parsed = parseGateOutput(parser, combined, {
      gate: label,
      exitCode: res.exitCode,
      cwd,
    });
    return {
      label,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: Date.now() - started,
      failures: parsed.failures,
      ...(parsed.tests ? { tests: parsed.tests } : {}),
    };
  };

  const runs: Partial<Record<DifferentialRunKey, DifferentialRun>> = {};
  let verdict: DifferentialVerdict | null = null;
  let regressions: RegressionFailure[] = [];
  let flaky: RegressionFailure[] = [];

  try {
    // 1. Pre-patch repro MUST fail on baseline.
    const baselineWt = await createWorktree("base");
    runs.prePatch = await runSuite(baselineWt, reproCmd, "baseline-pre-patch");
    if (runs.prePatch.timedOut) {
      verdict = { status: "reject_repro", reason: "timed-out-on-baseline" };
    } else if (runs.prePatch.exitCode === 0) {
      verdict = { status: "reject_repro", reason: "passed-on-baseline" };
    }

    // 2. Post-patch repro MUST pass on patched worktree.
    if (!verdict) {
      const patchedWt = await createWorktree("patched");
      const applied = await applyPatchInWorktree(patchedWt, options.candidateDiff);
      if (!applied) {
        verdict = { status: "reject_fix", reason: "patch-did-not-apply" };
      } else {
        runs.postPatch = await runSuite(patchedWt, reproCmd, "patched");
        if (runs.postPatch.timedOut || runs.postPatch.exitCode !== 0) {
          verdict = { status: "reject_fix", reason: "failed-after-patch" };
        } else {
          // 3. Regression delta across baseline vs patched trees.
          runs.regressionBaseline = await runSuite(baselineWt, regressionCmd, "regression-baseline");
          runs.regressionPatched = await runSuite(patchedWt, regressionCmd, "regression-patched");
          regressions = computeRegressions(runs.regressionBaseline, runs.regressionPatched);
          if (flakyReruns > 0 && regressions.length > 0) {
            for (let attempt = 1; attempt <= flakyReruns && regressions.length > 0; attempt++) {
              const rerun = await runSuite(
                patchedWt,
                regressionCmd,
                `regression-patched-rerun-${attempt}`,
              );
              const stillFailing = new Set(rerun.failures.map((f) => f.id));
              flaky = [...flaky, ...regressions.filter((r) => !stillFailing.has(r.id))];
              regressions = regressions.filter((r) => stillFailing.has(r.id));
            }
          }
          verdict = regressions.length === 0 ? { status: "pass" } : { status: "reject_regression" };
        }
      }
    }

    return {
      verdict,
      baseSha: options.baseSha,
      reproTestPath: options.reproTestPath,
      runs,
      regressions,
      flaky,
    };
  } finally {
    for (const wt of createdWorktrees) {
      await exec(["git", "-C", repoRoot, "worktree", "remove", "--force", wt]).catch(() => undefined);
      await exec(["rm", "-rf", wt]).catch(() => undefined);
    }
    await exec(["git", "-C", repoRoot, "worktree", "prune"]).catch(() => undefined);
  }
}
