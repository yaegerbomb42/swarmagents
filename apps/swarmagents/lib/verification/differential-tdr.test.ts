import test from "node:test";
import assert from "node:assert/strict";
import { runDifferentialMatrix } from "./differential-tdr";
import type { ShadowExec, ShadowExecResult } from "./shadow-verifier";

function makeMatrixExec(opts: {
  prePatchExit: number;
  applyFail?: boolean;
  postPatchExit?: number;
  baseFailures?: string[];
  patchedFailuresSeq?: string[][];
}): { exec: ShadowExec; commands: string[] } {
  const commands: string[] = [];
  let regPatchCalls = 0;
  const exec: ShadowExec = async (cmd, execOpts): Promise<ShadowExecResult> => {
    const joined = cmd.join(" ");
    commands.push(joined);
    if (cmd[0] === "git" && cmd.includes("apply")) {
      return { exitCode: opts.applyFail ? 1 : 0, stdout: "", stderr: opts.applyFail ? "conflict" : "" };
    }
    if (joined.includes("repro.test.ts")) {
      const isBase = execOpts?.cwd?.includes("tdr-base-") ?? false;
      const exitCode = isBase ? opts.prePatchExit : (opts.postPatchExit ?? 0);
      return { exitCode, stdout: "", stderr: "" };
    }
    if (joined.includes("vitest run --reporter=json")) {
      const isBase = execOpts?.cwd?.includes("tdr-base-") ?? false;
      const failIds = isBase
        ? (opts.baseFailures ?? [])
        : (opts.patchedFailuresSeq?.[regPatchCalls++] ?? []);
      const report = {
        numTotalTests: 5,
        numPassedTests: 5 - failIds.length,
        numFailedTests: failIds.length,
        testResults: [
          {
            name: `${execOpts?.cwd ?? ""}/suite.test.ts`,
            status: failIds.length ? "failed" : "passed",
            assertionResults: failIds.map((title) => ({
              fullName: title,
              status: "failed",
              failureMessages: ["boom"],
            })),
          },
        ],
      };
      return { exitCode: failIds.length ? 1 : 0, stdout: JSON.stringify(report), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { exec, commands };
}

test("runDifferentialMatrix rejects when repro passes on baseline", async () => {
  const { exec, commands } = makeMatrixExec({ prePatchExit: 0 });
  const res = await runDifferentialMatrix(exec, {
    repoRoot: "/workspace/repo",
    baseSha: "abc1234",
    candidateDiff: "diff --git a/x b/x\n",
    reproTestPath: "tests/repro.test.ts",
  });
  assert.deepEqual(res.verdict, { status: "reject_repro", reason: "passed-on-baseline" });
  assert.ok(commands.some((c) => c.includes("worktree remove --force")));
  assert.ok(commands.some((c) => c.includes("worktree prune")));
});

test("runDifferentialMatrix rejects when patch fails to apply or repro still fails", async () => {
  const applyFail = makeMatrixExec({ prePatchExit: 1, applyFail: true });
  const r1 = await runDifferentialMatrix(applyFail.exec, {
    repoRoot: "/workspace/repo",
    baseSha: "abc1234",
    candidateDiff: "bad diff",
    reproTestPath: "tests/repro.test.ts",
  });
  assert.deepEqual(r1.verdict, { status: "reject_fix", reason: "patch-did-not-apply" });

  const fixFail = makeMatrixExec({ prePatchExit: 1, postPatchExit: 1 });
  const r2 = await runDifferentialMatrix(fixFail.exec, {
    repoRoot: "/workspace/repo",
    baseSha: "abc1234",
    candidateDiff: "good diff",
    reproTestPath: "tests/repro.test.ts",
  });
  assert.deepEqual(r2.verdict, { status: "reject_fix", reason: "failed-after-patch" });
});

test("runDifferentialMatrix detects regressions and quarantines flaky failures on rerun", async () => {
  const reg = makeMatrixExec({
    prePatchExit: 1,
    postPatchExit: 0,
    baseFailures: ["preexisting"],
    patchedFailuresSeq: [["preexisting", "real-regression"]],
  });
  const r1 = await runDifferentialMatrix(reg.exec, {
    repoRoot: "/workspace/repo",
    baseSha: "abc1234",
    candidateDiff: "diff",
    reproTestPath: "tests/repro.test.ts",
  });
  assert.deepEqual(r1.verdict, { status: "reject_regression" });
  assert.equal(r1.regressions.length, 1);
  assert.match(r1.regressions[0]?.id ?? "", /real-regression/);

  const flaky = makeMatrixExec({
    prePatchExit: 1,
    postPatchExit: 0,
    baseFailures: ["preexisting"],
    patchedFailuresSeq: [["preexisting", "transient-flake"], ["preexisting"]],
  });
  const r2 = await runDifferentialMatrix(flaky.exec, {
    repoRoot: "/workspace/repo",
    baseSha: "abc1234",
    candidateDiff: "diff",
    reproTestPath: "tests/repro.test.ts",
    flakyReruns: 1,
  });
  assert.deepEqual(r2.verdict, { status: "pass" });
  assert.equal(r2.regressions.length, 0);
  assert.equal(r2.flaky.length, 1);
  assert.match(r2.flaky[0]?.id ?? "", /transient-flake/);
});

test("runDifferentialMatrix rejects unsafe reproTestPath or baseSha", async () => {
  const { exec } = makeMatrixExec({ prePatchExit: 1 });
  await assert.rejects(
    () =>
      runDifferentialMatrix(exec, {
        repoRoot: "/workspace/repo",
        baseSha: "abc1234",
        candidateDiff: "",
        reproTestPath: "../escape.test.ts",
      }),
    /escapes the repo root/,
  );
  await assert.rejects(
    () =>
      runDifferentialMatrix(exec, {
        repoRoot: "/workspace/repo",
        baseSha: "--upload-pack=evil",
        candidateDiff: "",
        reproTestPath: "tests/repro.test.ts",
      }),
    /valid git ref/,
  );
});
