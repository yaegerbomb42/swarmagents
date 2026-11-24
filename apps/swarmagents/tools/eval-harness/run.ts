// eval-harness CLI.
//
// Usage:
//   tsx tools/eval-harness/run.ts --baseline baseline --candidate wasteful --trials 3 --out eval-out
//   tsx tools/eval-harness/run.ts --dry-run        # CI self-check (see below)
//
// Normal mode runs the full suite for both configs, compares them with the
// Pareto gate, writes pareto-report.json + report.md to --out, and exits 0
// on PASS / 1 on REGRESSION.
//
// --dry-run is the CI self-check: it verifies the harness itself works by
// running (a) baseline vs baseline, which must be clean, and (b) baseline
// vs wasteful, which must trip the gate; it also verifies every bucket ran
// and that no isolated run directory leaks. It exits 0 only if all checks
// behave as expected.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregateReport,
  compareReports,
  HarnessEvalRunner,
  LocalTempIsolation,
  renderMarkdownReport,
  writeParetoReport,
  EVAL_SUITE,
  type EvalReport,
  type HarnessConfig,
  type ParetoComparison,
} from "../../lib/eval/index";

export interface CliOptions {
  baselineProfile: HarnessConfig["profile"];
  candidateProfile: HarnessConfig["profile"];
  trials: number;
  outDir: string;
  taskIds: string[] | null;
  seed: number;
  modelTier: "strong" | "cheap";
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    baselineProfile: "baseline",
    candidateProfile: "wasteful",
    trials: 3,
    outDir: "eval-out",
    taskIds: null,
    seed: 20261122,
    modelTier: "strong",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--baseline" && next) opts.baselineProfile = next as CliOptions["baselineProfile"];
    else if (arg === "--candidate" && next) opts.candidateProfile = next as CliOptions["candidateProfile"];
    else if (arg === "--trials" && next) opts.trials = Math.max(1, parseInt(next, 10) || 3);
    else if (arg === "--out" && next) opts.outDir = next;
    else if (arg === "--tasks" && next) opts.taskIds = next.split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--seed" && next) opts.seed = parseInt(next, 10) || opts.seed;
    else if (arg === "--model-tier" && next) opts.modelTier = next as CliOptions["modelTier"];
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx tools/eval-harness/run.ts [--baseline baseline|wasteful|broken] " +
          "[--candidate baseline|wasteful|broken] [--trials N] [--out DIR] " +
          "[--tasks id1,id2] [--seed N] [--model-tier strong|cheap] [--dry-run]"
      );
      process.exit(0);
    }
    if (arg.startsWith("--") && next && arg !== "--dry-run" && arg !== "--help" && arg !== "-h") i++;
  }
  const valid = ["baseline", "wasteful", "broken"];
  if (!valid.includes(opts.baselineProfile) || !valid.includes(opts.candidateProfile)) {
    throw new Error("--baseline/--candidate must be one of baseline, wasteful, broken");
  }
  return opts;
}

function configFor(name: string, profile: HarnessConfig["profile"], modelTier: "strong" | "cheap"): HarnessConfig {
  return { name, profile, modelTier };
}

async function leftoverRunDirs(root: string): Promise<string[]> {
  // Scoped to this run's own isolation root: the shared tmpdir also holds
  // other concurrent eval runs, whose in-flight directories are not leaks.
  const entries = await readdir(root);
  return entries.filter((e) => e.startsWith("swarm-eval-"));
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function runDryRun(opts: CliOptions): Promise<number> {
  const checks: CheckResult[] = [];
  // The dry-run's runs live under their own isolation root, so the leak
  // check sees only this run's directories — never another concurrent
  // eval run's in-flight directories in the shared tmpdir.
  const isolationRoot = await mkdtemp(path.join(os.tmpdir(), "swarm-eval-dryrun-"));
  const runner = new HarnessEvalRunner({ isolation: new LocalTempIsolation(isolationRoot) });
  try {

  const baselineConfig = configFor("baseline", "baseline", opts.modelTier);
  const baselineResults = await runner.runSuite(baselineConfig, { trialsPerTask: 1 });
  const baseline = aggregateReport(baselineResults, baselineConfig, 1, opts.seed);

  const sameResults = await runner.runSuite(
    configFor("baseline-copy", "baseline", opts.modelTier),
    { trialsPerTask: 1 }
  );
  const same = aggregateReport(sameResults, configFor("baseline-copy", "baseline", opts.modelTier), 1, opts.seed);
  const sameComparison = compareReports(baseline, same, opts.seed);
  checks.push({
    name: "baseline vs baseline is clean",
    pass: !sameComparison.regression && same.solveRate === baseline.solveRate,
    detail: `solve ${same.solveRate.toFixed(2)} vs ${baseline.solveRate.toFixed(2)}, regression=${sameComparison.regression}`,
  });

  const wastefulConfig = configFor("wasteful", "wasteful", opts.modelTier);
  const wastefulResults = await runner.runSuite(wastefulConfig, { trialsPerTask: 1 });
  const wasteful = aggregateReport(wastefulResults, wastefulConfig, 1, opts.seed);
  const wastefulComparison = compareReports(baseline, wasteful, opts.seed);
  checks.push({
    name: "baseline vs wasteful trips the gate",
    pass:
      wastefulComparison.regression &&
      wastefulComparison.reasons.some((r) => r.includes("token burn")),
    detail: `token delta ${(wastefulComparison.tokenDeltaFrac * 100).toFixed(1)}%, reasons: ${wastefulComparison.reasons.join("; ")}`,
  });

  const bucketsRan = ["surgical", "feature", "long-horizon"].every(
    (b) => baseline.byBucket[b as keyof EvalReport["byBucket"]].tasks === 5
  );
  checks.push({
    name: "all 3 buckets ran with 5 tasks each",
    pass: baseline.tasksRun === 15 && bucketsRan,
    detail: `${baseline.tasksRun} tasks, buckets: ${["surgical", "feature", "long-horizon"].map((b) => baseline.byBucket[b as keyof EvalReport["byBucket"]].tasks).join("/")}`,
  });

  const leaked = await leftoverRunDirs(isolationRoot);
  checks.push({
    name: "no isolated run directory leaked",
    pass: leaked.length === 0,
    detail: leaked.length === 0 ? "tmp clean" : `leaked: ${leaked.join(", ")}`,
  });

  let allPass = true;
  for (const check of checks) {
    console.log(`${check.pass ? "PASS" : "FAIL"}: ${check.name} — ${check.detail}`);
    if (!check.pass) allPass = false;
  }
  return allPass ? 0 : 1;
  } finally {
    await rm(isolationRoot, { recursive: true, force: true });
  }
}

async function runAb(opts: CliOptions): Promise<number> {
  const runner = new HarnessEvalRunner();
  const tasks = opts.taskIds
    ? EVAL_SUITE.filter((t) => opts.taskIds!.includes(t.id))
    : EVAL_SUITE;
  if (tasks.length === 0) {
    console.error("No tasks matched --tasks.");
    return 2;
  }
  const baselineConfig = configFor("baseline", opts.baselineProfile, opts.modelTier);
  const candidateConfig = configFor("candidate", opts.candidateProfile, opts.modelTier);

  console.log(`Running baseline (${baselineConfig.profile}) on ${tasks.length} tasks x ${opts.trials} trials...`);
  const baselineResults = await runner.runSuite(baselineConfig, { tasks, trialsPerTask: opts.trials });
  const baseline = aggregateReport(baselineResults, baselineConfig, opts.trials, opts.seed);

  console.log(`Running candidate (${candidateConfig.profile}) on ${tasks.length} tasks x ${opts.trials} trials...`);
  const candidateResults = await runner.runSuite(candidateConfig, { tasks, trialsPerTask: opts.trials });
  const candidate = aggregateReport(candidateResults, candidateConfig, opts.trials, opts.seed);

  const comparison: ParetoComparison = compareReports(baseline, candidate, opts.seed);
  const { jsonPath, markdownPath } = await writeParetoReport(
    opts.outDir,
    baseline,
    candidate,
    comparison
  );
  console.log(renderMarkdownReport(candidate, comparison));
  console.log(`Reports written: ${path.resolve(jsonPath)}, ${path.resolve(markdownPath)}`);
  console.log(`Pareto gate: ${comparison.regression ? "REGRESSION" : "PASS"}`);
  if (comparison.reasons.length > 0) {
    for (const reason of comparison.reasons) console.log(`  - ${reason}`);
  }
  return comparison.regression ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  return opts.dryRun ? runDryRun(opts) : runAb(opts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : err);
      process.exit(2);
    }
  );
}
