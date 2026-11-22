// CLI tests. The dry-run test exercises the real CLI end to end (full
// suite, mock driver); the A/B tests use a single surgical task to stay
// fast while still checking the exit-code contract.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "./run";

const execFileAsync = promisify(execFile);

const APP_DIR = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(APP_DIR, "tools/eval-harness/run.ts");

test("parseArgs defaults and flags", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.baselineProfile, "baseline");
  assert.equal(defaults.candidateProfile, "wasteful");
  assert.equal(defaults.trials, 3);
  assert.equal(defaults.dryRun, false);
  const custom = parseArgs([
    "--baseline", "broken",
    "--candidate", "baseline",
    "--trials", "1",
    "--tasks", "a,b",
    "--seed", "5",
    "--model-tier", "cheap",
    "--dry-run",
  ]);
  assert.equal(custom.baselineProfile, "broken");
  assert.equal(custom.candidateProfile, "baseline");
  assert.equal(custom.trials, 1);
  assert.deepEqual(custom.taskIds, ["a", "b"]);
  assert.equal(custom.seed, 5);
  assert.equal(custom.modelTier, "cheap");
  assert.equal(custom.dryRun, true);
  assert.throws(() => parseArgs(["--baseline", "nope"]), /must be one of/);
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["tsx", CLI, ...args],
      { cwd: APP_DIR, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("CLI --dry-run exits 0 with all checks passing", async () => {
  const { code, stdout } = await runCli(["--dry-run"]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /PASS: baseline vs baseline is clean/);
  assert.match(stdout, /PASS: baseline vs wasteful trips the gate/);
  assert.match(stdout, /PASS: all 3 buckets ran with 5 tasks each/);
  assert.match(stdout, /PASS: no isolated run directory leaked/);
});

test("CLI A/B baseline vs wasteful on one task exits 1 (regression)", async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), "eval-cli-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { code, stdout } = await runCli([
    "--baseline", "baseline",
    "--candidate", "wasteful",
    "--trials", "1",
    "--tasks", "surgical-rate-limiter-off-by-one",
    "--out", out,
  ]);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /REGRESSION/);
  assert.match(stdout, /token burn rose/);
});

test("CLI A/B baseline vs baseline on one task exits 0 (clean)", async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), "eval-cli-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { code, stdout } = await runCli([
    "--baseline", "baseline",
    "--candidate", "baseline",
    "--trials", "1",
    "--tasks", "surgical-rate-limiter-off-by-one",
    "--out", out,
  ]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Pareto gate: PASS/);
});
