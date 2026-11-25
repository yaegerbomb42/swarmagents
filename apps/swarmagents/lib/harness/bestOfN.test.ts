/**
 * Best-of-N tests (lib/harness/bestOfN.ts).
 *
 * The dispatcher is dependency-injected: candidates come from a fake
 * runCandidate and the oracle from a fake gate, so the fan-out, selection
 * and fail-open semantics are proven without a VM. One case runs the real
 * oracle gate against a throwaway git repo (same pattern as
 * oracle.test.ts) to prove the dispatcher + gate agree on the winner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bestOfNFromEnv,
  dedupeFamilies,
  isNonTrivialDiff,
  modelForFamily,
  parseBestOfNFamily,
  resolveBestOfNConfig,
  runBestOfN,
  shouldFanOutBestOfN,
  type BestOfNFamily,
} from "./bestOfN";
import { runOracleGate, type OracleCandidate, type OracleReport } from "./oracle/oracle";
import type { OracleExec } from "./oracle/exec";

const diffFor = (file: string, lines: number): string => {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n");
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,${lines} @@\n${body}\n`;
};

const twoFileDiff = `${diffFor("lib/a.ts", 2)}${diffFor("lib/b.ts", 2)}`;

test("parseBestOfNFamily accepts family, provider:model and bare model ids", () => {
  assert.deepEqual(parseBestOfNFamily("deepseek"), { family: "deepseek" });
  assert.deepEqual(parseBestOfNFamily("deepseek:deepseek-chat"), { family: "deepseek", model: "deepseek-chat" });
  assert.deepEqual(parseBestOfNFamily("deepseek-chat"), { family: "deepseek", model: "deepseek-chat" });
  assert.deepEqual(parseBestOfNFamily("Qwen3-Coder-Plus"), { family: "qwen", model: "Qwen3-Coder-Plus" });
  assert.equal(parseBestOfNFamily(""), null);
  assert.equal(parseBestOfNFamily("not-a-family-or-model"), null);
  assert.equal(parseBestOfNFamily("deepseek:"), null);
  assert.equal(parseBestOfNFamily(42), null);
});

test("modelForFamily returns the catalog default code model", () => {
  assert.equal(modelForFamily({ family: "deepseek" }), "deepseek-chat");
  assert.equal(modelForFamily({ family: "qwen" }), "qwen3-coder-plus");
  assert.equal(modelForFamily({ family: "glm" }), "glm-4.5");
  assert.equal(modelForFamily({ family: "deepseek", model: "deepseek-reasoner" }), "deepseek-reasoner");
  assert.equal(modelForFamily({ family: "claude" }), undefined);
});

test("dedupeFamilies drops repeats, keeps first-seen order", () => {
  const families: BestOfNFamily[] = [
    { family: "deepseek" },
    { family: "qwen" },
    { family: "deepseek" },
    { family: "deepseek", model: "deepseek-reasoner" },
  ];
  assert.deepEqual(dedupeFamilies(families), [
    { family: "deepseek" },
    { family: "qwen" },
    { family: "deepseek", model: "deepseek-reasoner" },
  ]);
});

test("bestOfNFromEnv parses count, families and mode; 0 disables", () => {
  assert.deepEqual(bestOfNFromEnv({}), {});
  assert.deepEqual(bestOfNFromEnv({ SWARM_BEST_OF_N: "2" }), { n: 2 });
  assert.deepEqual(bestOfNFromEnv({ SWARM_BEST_OF_N: "0" }), { disabled: true });
  assert.deepEqual(bestOfNFromEnv({ SWARM_BEST_OF_N: "false" }), { disabled: true });
  assert.deepEqual(bestOfNFromEnv({ SWARM_BEST_OF_N_FAMILIES: "deepseek,qwen" }), {
    families: [{ family: "deepseek" }, { family: "qwen" }],
  });
  assert.deepEqual(bestOfNFromEnv({ SWARM_BEST_OF_N_MODE: "best" }), { mode: "best" });
  assert.deepEqual(bestOfNFromEnv({ SWARM_BEST_OF_N_MODE: "bogus" }), {});
  assert.deepEqual(bestOfNFromEnv({ SWARM_BEST_OF_N: "not-a-number" }), {});
});

test("resolveBestOfNConfig: role wins over env, env over defaults; disabled unless N>=2 and 2 families", () => {
  // Defaults: 3 candidates across deepseek/qwen/glm.
  const defaults = resolveBestOfNConfig(undefined, {});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.n, 3);
  assert.deepEqual(
    defaults.families.map((f) => f.family),
    ["deepseek", "qwen", "glm"],
  );
  assert.equal(defaults.mode, "first");

  // Role narrows N and the families; env mode survives.
  const role = resolveBestOfNConfig(
    { n: 2, families: ["deepseek", "glm"] },
    { SWARM_BEST_OF_N_MODE: "best" },
  );
  assert.equal(role.enabled, true);
  assert.equal(role.n, 2);
  assert.deepEqual(
    role.families.map((f) => f.family),
    ["deepseek", "glm"],
  );
  assert.equal(role.mode, "best");

  // N=1 is not a fan-out.
  assert.equal(resolveBestOfNConfig({ n: 1 }, {}).enabled, false);
  // One family is not a fan-out.
  assert.equal(resolveBestOfNConfig({ n: 3, families: ["deepseek"] }, {}).enabled, false);
  // Env disable beats a role config.
  assert.equal(
    resolveBestOfNConfig({ n: 3, families: ["deepseek", "qwen"] }, { SWARM_BEST_OF_N: "0" }).enabled,
    false,
  );
  // N clamps to 3 and families slice to N.
  const clamped = resolveBestOfNConfig({ n: 9 }, {});
  assert.equal(clamped.n, 3);
  assert.equal(clamped.families.length, 3);
  // Junk families drop out; unknown specs never enable the feature alone.
  assert.equal(resolveBestOfNConfig({ families: ["nope", "also-nope"] }, {}).enabled, true); // falls back to defaults
  assert.deepEqual(
    resolveBestOfNConfig({ families: ["deepseek", "nope", "qwen"] }, {}).families.map((f) => f.family),
    ["deepseek", "qwen"],
  );
});

test("isNonTrivialDiff: churn threshold, multi-file, empty", () => {
  assert.equal(isNonTrivialDiff(""), false);
  assert.equal(isNonTrivialDiff(diffFor("lib/a.ts", 3)), false);
  assert.equal(isNonTrivialDiff(diffFor("lib/a.ts", 20)), true);
  assert.equal(isNonTrivialDiff(diffFor("lib/a.ts", 19)), false);
  assert.equal(isNonTrivialDiff(twoFileDiff), true); // 4 lines, but 2 files
  assert.equal(isNonTrivialDiff(diffFor("lib/a.ts", 20), { minChurn: 100 }), false);
  assert.equal(isNonTrivialDiff(diffFor("lib/a.ts", 100), { minChurn: 100 }), true);
});

test("shouldFanOutBestOfN: disabled config or trivial diff never fans out", () => {
  const config = resolveBestOfNConfig(undefined, {});
  assert.equal(shouldFanOutBestOfN(config, diffFor("lib/a.ts", 30)), true);
  assert.equal(shouldFanOutBestOfN(config, diffFor("lib/a.ts", 3)), false);
  assert.equal(shouldFanOutBestOfN(config, undefined), false);
  assert.equal(shouldFanOutBestOfN(config, ""), false);
  const off = resolveBestOfNConfig({ n: 1 }, {});
  assert.equal(shouldFanOutBestOfN(off, diffFor("lib/a.ts", 30)), false);
});

const fakeGate = (landed: string[], rejected = 0): ((candidates: OracleCandidate[]) => Promise<OracleReport>) =>
  async (candidates) => ({
    verdicts: candidates.map((candidate) => ({
      id: candidate.id,
      status: landed.includes(candidate.id) ? "passed" : "rejected",
      ...(landed.includes(candidate.id)
        ? { landed: true, churn: 1, checks: [] }
        : { stage: "tsc", diagnostic: "boom", retryContext: "boom", checks: [] }),
    })),
    landed,
    rejected,
    total: candidates.length,
    summary: `oracle: ${rejected}/${candidates.length} candidates rejected`,
  });

test("runBestOfN: parallel dispatch, first passing candidate wins", async () => {
  const seen: string[] = [];
  const outcome = await runBestOfN(
    {
      runCandidate: async (family, index) => {
        seen.push(family.family);
        // DeepSeek's diff is broken (gate rejects it); the other two pass.
        return { id: `${family.family}-${index}`, diff: diffFor(`lib/${family.family}.ts`, 25) };
      },
      gate: fakeGate(["qwen-1", "glm-2"], 1),
      log: () => {},
    },
    { families: [{ family: "deepseek" }, { family: "qwen" }, { family: "glm" }] },
  );
  assert.deepEqual(seen, ["deepseek", "qwen", "glm"]);
  assert.equal(outcome.winner?.id, "qwen-1");
  assert.equal(outcome.winner?.family.family, "qwen");
  assert.equal(outcome.attempted, 3);
  assert.equal(outcome.gated, 3);
  assert.deepEqual(outcome.skipped, []);
  assert.match(outcome.summary, /2\/3 candidates passed the oracle; winner qwen-1/);
});

test("runBestOfN: candidates run in parallel, not one after another", async () => {
  let concurrent = 0;
  let peak = 0;
  const outcome = await runBestOfN(
    {
      runCandidate: async (family, index) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent--;
        return { id: `${family.family}-${index}`, diff: diffFor(`lib/${family.family}.ts`, 25) };
      },
      gate: fakeGate(["deepseek-0"], 2),
    },
    { families: [{ family: "deepseek" }, { family: "qwen" }, { family: "glm" }] },
  );
  assert.equal(peak, 3);
  assert.equal(outcome.winner?.id, "deepseek-0");
});

test("runBestOfN: erroring and empty candidates are skipped, not gated", async () => {
  const gated: OracleCandidate[] = [];
  const outcome = await runBestOfN(
    {
      runCandidate: async (family, index) => {
        if (family.family === "deepseek") throw new Error("model blew up");
        if (family.family === "qwen") return null;
        if (family.family === "glm") return { id: `glm-${index}`, diff: "   " };
        return { id: `${family.family}-${index}`, diff: diffFor(`lib/${family.family}.ts`, 25) };
      },
      gate: async (candidates) => {
        gated.push(...candidates);
        return fakeGate(["claude-3"], 0)(candidates);
      },
    },
    { families: [{ family: "deepseek" }, { family: "qwen" }, { family: "glm" }, { family: "claude" }] },
  );
  assert.deepEqual(
    gated.map((c) => c.id),
    ["claude-3"],
  );
  assert.equal(outcome.winner?.id, "claude-3");
  assert.deepEqual(outcome.skipped, ["deepseek-0", "qwen-1", "glm-2"]);
  assert.equal(outcome.gated, 1);
});

test("runBestOfN: nothing passes → winner null, caller can bounce", async () => {
  const outcome = await runBestOfN(
    {
      runCandidate: async (family, index) => ({ id: `${family.family}-${index}`, diff: diffFor("lib/a.ts", 25) }),
      gate: fakeGate([], 2),
    },
    { families: [{ family: "deepseek" }, { family: "qwen" }] },
  );
  assert.equal(outcome.winner, null);
  assert.equal(outcome.report?.landed.length, 0);
  assert.match(outcome.summary, /0\/2 candidates passed the oracle/);
});

test("runBestOfN: no diffs at all → gate never runs", async () => {
  let gateCalls = 0;
  const outcome = await runBestOfN(
    {
      runCandidate: async () => null,
      gate: async (candidates) => {
        gateCalls++;
        return fakeGate([], 0)(candidates);
      },
    },
    { families: [{ family: "deepseek" }, { family: "qwen" }] },
  );
  assert.equal(gateCalls, 0);
  assert.equal(outcome.winner, null);
  assert.match(outcome.summary, /0\/2 candidates produced a diff/);
});

test("runBestOfN: gate error fails open with winner null", async () => {
  const lines: string[] = [];
  const outcome = await runBestOfN(
    {
      runCandidate: async (family, index) => ({ id: `${family.family}-${index}`, diff: diffFor("lib/a.ts", 25) }),
      gate: async () => {
        throw new Error("scratch exploded");
      },
      log: (line) => lines.push(line),
    },
    { families: [{ family: "deepseek" }, { family: "qwen" }] },
  );
  assert.equal(outcome.winner, null);
  assert.equal(outcome.gateError, "scratch exploded");
  assert.match(lines.join("\n"), /oracle gate failed/);
});

const APP = process.cwd();
const TSC = join(APP, "node_modules/typescript/bin/tsc");

test("runBestOfN + real oracle gate: the passing candidate lands", { timeout: 120_000 }, async (t) => {
  assert.ok(existsSync(TSC), "typescript must be installed");
  // Tiny TS project in a fresh git repo: <tmp>/repo/app/{tsconfig.json,src/*}.
  const root = mkdtempSync(join(tmpdir(), "best-of-n-"));
  const repo = join(root, "repo");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(repo, "app/src"), { recursive: true });
  writeFileSync(
    join(repo, "app/tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "esnext", moduleResolution: "bundler", types: [], skipLibCheck: true },
      include: ["src/**/*.ts"],
    }),
  );
  writeFileSync(join(repo, "app/src/a.ts"), "export const a = 1;\n");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "best-of-n-test@example.invalid");
  git("config", "user.name", "best-of-n-test");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  // Build each candidate's diff by editing a copy, diffing, and resetting.
  const diffForEdits = (edits: Record<string, string>): string => {
    for (const [file, content] of Object.entries(edits)) {
      writeFileSync(join(repo, file), content);
    }
    git("add", "-N", ".");
    const diff = git("diff");
    git("reset", "-q");
    git("checkout", "-q", "--", ".");
    git("clean", "-fdq");
    return diff;
  };
  const goodDiff = diffForEdits({ "app/src/a.ts": "export const a = 2;\n" });
  const badDiff = diffForEdits({ "app/src/a.ts": 'export const a: string = 2;\nexport const b: number = "nope";\n' });

  // A local exec that runs commands on the host (same shape as the VM exec).
  const { execFile } = await import("node:child_process");
  const exec: OracleExec = (cmd, opts) =>
    new Promise((resolve) => {
      execFile(cmd[0], cmd.slice(1), { cwd: opts?.cwd ?? repo }, (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      });
    });

  const outcome = await runBestOfN(
    {
      runCandidate: async (family, index) => ({
        id: `${family.family}-${index}`,
        diff: family.family === "deepseek" ? badDiff : goodDiff,
      }),
      gate: (candidates) =>
        runOracleGate(exec, candidates, {
          repoRoot: repo,
          projectDir: "app",
          mode: "first",
          checks: [{ name: "tsc", command: () => [process.execPath, TSC, "--noEmit", "-p", "tsconfig.json"] }],
        }),
    },
    { families: [{ family: "deepseek" }, { family: "qwen" }] },
  );
  // DeepSeek's diff fails tsc; Qwen's passes and lands in the real tree.
  assert.equal(outcome.winner?.id, "qwen-1");
  assert.match(outcome.summary, /winner qwen-1/);
});
