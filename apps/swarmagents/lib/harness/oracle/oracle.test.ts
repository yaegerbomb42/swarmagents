/**
 * Oracle gate tests (lib/harness/oracle/).
 *
 * The end-to-end cases use a real throwaway git repo, real `git apply`,
 * the real TypeScript compiler and real `tsx --test` runs from this app's
 * node_modules, so "the broken patch never lands" is proven against the
 * same tools the gate runs in production — not against mocks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOracleChecks, OracleGate, runOracleGate, type OracleCheck } from "./oracle";
import { countChurn, parsePatchFiles, unsafePatchPaths, type PatchFile } from "./diff";
import { findAffectedTests, relativeImports, resolveSpecifier, TRANSITIVE_HOPS } from "./affected";
import { buildRetryContext, diagnosticSymbols, extractDiagnostic, findDefinition } from "./retry";
import { execWithTimeout, writeFileViaExec, type OracleExec } from "./exec";
import { createScratch } from "./scratch";

const APP = process.cwd();
const TSC = join(APP, "node_modules/typescript/bin/tsc");
const TSX = join(APP, "node_modules/tsx/dist/cli.mjs");

/**
 * Child env for the local exec. NODE_TEST_CONTEXT is dropped: node:test sets
 * it for its own children, and a nested `--test` run would then report to
 * this runner instead of exiting non-zero on failure (the VM exec never has it).
 * Typed as ProcessEnv: spawn's env option requires it, and the filtered
 * Object.fromEntries shape alone does not satisfy it.
 */
const CHILD_ENV: NodeJS.ProcessEnv = { ...process.env };
delete CHILD_ENV.NODE_TEST_CONTEXT;

/** Local exec: argv only, no shell — the same contract as the VM exec. */
const localExec: OracleExec = (cmd, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: opts?.cwd, signal: opts?.signal, env: CHILD_ENV });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ exitCode: 127, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const MATH = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

const MATH_TEST = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "./math";',
  "",
  'test("add", () => {',
  "  assert.equal(add(2, 3), 5);",
  "});",
  "",
].join("\n");

/** A tiny TS project in a fresh git repo: <tmp>/repo/app/{tsconfig.json,src/*}. */
function makeRepo(): { root: string; repo: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "oracle-test-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "app/src"), { recursive: true });
  writeFileSync(
    join(repo, "app/tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "esnext", moduleResolution: "bundler", types: [] , skipLibCheck: true}, include: ["src/**/*.ts"] }),
  );
  writeFileSync(join(repo, "app/src/math.ts"), MATH);
  writeFileSync(join(repo, "app/src/math.test.ts"), MATH_TEST);
  writeFileSync(join(repo, "app/src/node-test.d.ts"), 'declare module "node:test" { const test: (name: string, fn: () => void) => void; export default test; }\ndeclare module "node:assert/strict" { const assert: { equal(a: unknown, b: unknown): void }; export default assert; }\n');
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "oracle-test@example.invalid");
  git(repo, "config", "user.name", "oracle-test");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Build a candidate diff by editing a copy, diffing, and resetting. */
function diffFor(repo: string, edits: Record<string, string>): string {
  for (const [file, content] of Object.entries(edits)) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
  git(repo, "add", "-N", ".");
  const diff = git(repo, "diff");
  git(repo, "reset", "-q");
  git(repo, "checkout", "-q", "--", ".");
  git(repo, "clean", "-fdq");
  return diff;
}

/** Real checks: tsc, a lint stand-in, and tsx --test on the affected tests. */
const CHECKS: OracleCheck[] = [
  { name: "tsc", command: () => [process.execPath, TSC, "--noEmit", "-p", "tsconfig.json"] },
  {
    name: "lint",
    // Lint stand-in: reject `debugger` statements in changed files.
    command: (ctx) =>
      ctx.changedFiles.length
        ? [process.execPath, "-e", "const fs=require('fs');const bad=process.argv.slice(1).filter(f=>/\\bdebugger\\b/.test(fs.readFileSync(f,'utf8')));if(bad.length){console.error('error  no-debugger: '+bad.join(','));process.exit(1)}", ...ctx.changedFiles]
        : null,
  },
  { name: "tests", command: (ctx) => (ctx.affectedTests.length ? [process.execPath, TSX, "--test", ...ctx.affectedTests] : null) },
];

test("acceptance: a seeded broken patch never lands; log says 'oracle: 2/3 candidates rejected'", { timeout: 120_000 }, async () => {
  assert.ok(existsSync(TSC) && existsSync(TSX), "typescript and tsx must be installed");
  const { root, repo, cleanup } = makeRepo();
  try {
    const typeError = diffFor(repo, { "app/src/math.ts": MATH.replace("return a + b;", 'return `${a}${b}`;') });
    const brokenLogic = diffFor(repo, { "app/src/math.ts": MATH.replace("a + b", "a - b") });
    const good = diffFor(repo, {
      "app/src/math.ts": MATH + "export function mul(a: number, b: number): number {\n  return a * b;\n}\n",
      "app/src/mul.test.ts": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { mul } from "./math";\n\ntest("mul", () => {\n  assert.equal(mul(2, 3), 6);\n});\n',
    });
    assert.ok(typeError && brokenLogic && good);

    const logs: string[] = [];
    const report = await runOracleGate(
      localExec,
      [
        { id: "c1-type-error", diff: typeError },
        { id: "c2-broken-logic", diff: brokenLogic },
        { id: "c3-good", diff: good },
      ],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, scratchRoot: join(root, "scratch"), log: (l) => logs.push(l) },
    );

    assert.ok(logs.includes("oracle: 2/3 candidates rejected; landed c3-good"), logs.join("\n"));
    assert.match(report.summary, /^oracle: 2\/3 candidates rejected/);
    assert.equal(report.rejected, 2);
    assert.deepEqual(report.landed, ["c3-good"]);

    const [v1, v2, v3] = report.verdicts;
    assert.equal(v1.status, "rejected");
    assert.equal(v1.status === "rejected" && v1.stage, "tsc");
    assert.match(v1.status === "rejected" ? v1.diagnostic : "", /error TS2322/);
    assert.equal(v2.status === "rejected" && v2.stage, "tests");
    assert.deepEqual(v2.checks.map((c) => `${c.name}:${c.status}`), ["tsc:passed", "lint:passed", "tests:failed"]);
    assert.equal(v3.status === "passed" && v3.landed, true);

    // The real tree has the good patch and nothing from the broken ones.
    const math = readFileSync(join(repo, "app/src/math.ts"), "utf8");
    assert.match(math, /return a \+ b;/);
    assert.match(math, /export function mul/);
    assert.doesNotMatch(math, /a - b|\$\{a\}\$\{b\}/);
    assert.ok(existsSync(join(repo, "app/src/mul.test.ts")));

    // Scratch worktrees are gone.
    assert.equal(git(repo, "worktree", "list").trim().split("\n").length, 1);
    for (const line of logs) console.log(line);
  } finally {
    cleanup();
  }
});

test("a lone broken patch never lands, the tree stays clean, and the retry gets diagnostic + definition only", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const broken = diffFor(repo, {
      "app/src/math.test.ts": MATH_TEST.replace("add(2, 3)", "add(2, '3')"),
    });
    const report = await runOracleGate(localExec, [{ id: "only", diff: broken }], {
      repoRoot: repo,
      projectDir: "app",
      checks: CHECKS,
      scratchRoot: join(root, "scratch"),
    });
    assert.equal(report.summary, "oracle: 1/1 candidates rejected; nothing landed");
    assert.deepEqual(report.landed, []);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(repo, "app/src/math.test.ts"), "utf8"), MATH_TEST);

    const retry = report.retryContext ?? "";
    assert.match(retry, /rejected by the oracle at "tsc" and its patch was discarded/);
    assert.match(retry, /error TS2345/);
    // The failed patch text is evicted from the retry.
    assert.doesNotMatch(retry, /add\(2, '3'\)/);
  } finally {
    cleanup();
  }
});

test("retry context carries the named symbol's definition from the real tree", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const broken = diffFor(repo, { "app/src/math.ts": MATH + "export const total = add(1);\n" });
    const report = await runOracleGate(localExec, [{ id: "c", diff: broken }], {
      repoRoot: repo,
      projectDir: "app",
      checks: CHECKS,
      scratchRoot: join(root, "scratch"),
    });
    assert.deepEqual(report.landed, []);
    const retry = report.retryContext ?? "";
    assert.match(retry, /error TS2554/);
    assert.match(retry, /Definition of `add` \(app\/src\/math\.ts:L1-3\):\n1 \| export function add\(a: number, b: number\): number \{/);
  } finally {
    cleanup();
  }
});

test("candidates are judged against uncommitted state; a patch that does not apply is rejected at apply", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    // Candidate depends on an uncommitted helper in the real tree.
    const good = diffFor(repo, {
      "app/src/math.ts": MATH + 'import { two } from "./helper";\nexport const four = add(two, two);\n',
    });
    writeFileSync(join(repo, "app/src/helper.ts"), "export const two = 2;\n");
    const stale = "diff --git a/app/src/math.ts b/app/src/math.ts\n--- a/app/src/math.ts\n+++ b/app/src/math.ts\n@@ -1,3 +1,3 @@\n-export function nope() {\n+export function nope2() {\n   return a + b;\n }\n";

    const logs: string[] = [];
    const report = await runOracleGate(
      localExec,
      [
        { id: "stale", diff: stale },
        { id: "uses-helper", diff: good },
      ],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, scratchRoot: join(root, "scratch"), log: (l) => logs.push(l) },
    );
    assert.equal(report.verdicts[0].status === "rejected" && report.verdicts[0].stage, "apply", JSON.stringify(report.verdicts[0]));
    assert.deepEqual(report.landed, ["uses-helper"]);
    assert.ok(logs.includes("oracle: 1/2 candidates rejected; landed uses-helper"));
    assert.match(readFileSync(join(repo, "app/src/math.ts"), "utf8"), /export const four/);
  } finally {
    cleanup();
  }
});

test("mode 'all' stacks sequential patches; 'best' prefers the smaller passing diff", { timeout: 120_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const step1 = diffFor(repo, { "app/src/math.ts": MATH + "export const one = 1;\n" });
    // step2 is written against the tree *after* step1.
    writeFileSync(join(repo, "app/src/math.ts"), MATH + "export const one = 1;\n");
    git(repo, "add", "app/src/math.ts");
    writeFileSync(join(repo, "app/src/math.ts"), MATH + "export const one = 1;\nexport const two = one + one;\n");
    const step2 = git(repo, "diff"); // worktree vs index = against the post-step1 tree
    git(repo, "reset", "-q");
    git(repo, "checkout", "-q", "--", ".");

    const all = await runOracleGate(
      localExec,
      [
        { id: "s1", diff: step1 },
        { id: "s2", diff: step2 },
      ],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, mode: "all", scratchRoot: join(root, "scratch") },
    );
    assert.deepEqual(all.landed, ["s1", "s2"]);
    assert.match(readFileSync(join(repo, "app/src/math.ts"), "utf8"), /export const two = one \+ one;/);

    git(repo, "checkout", "-q", "--", ".");
    const small = diffFor(repo, { "app/src/math.ts": MATH + "export const z = 0;\n" });
    const big = diffFor(repo, { "app/src/math.ts": MATH + "export const z = 0;\nexport const y = 1;\nexport const x = 2;\n" });
    const best = await runOracleGate(
      localExec,
      [
        { id: "big", diff: big },
        { id: "small", diff: small },
      ],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, scratchRoot: join(root, "scratch") },
    );
    assert.deepEqual(best.landed, ["small"]);
    assert.equal(best.rejected, 0);
    const bigVerdict = best.verdicts[0];
    assert.equal(bigVerdict.status === "passed" && bigVerdict.landed, false);
    assert.match(bigVerdict.status === "passed" ? bigVerdict.note ?? "" : "", /small has less churn/);
  } finally {
    cleanup();
  }
});

test("best mode evaluates candidates concurrently within its configured bound", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const candidates = [1, 2, 3, 4].map((n) => ({
      id: `candidate-${n}`,
      diff: diffFor(repo, { "app/src/math.ts": `${MATH}export const candidate${n} = ${n};\n` }),
    }));
    let active = 0;
    let maxActive = 0;
    const trackedExec: OracleExec = async (cmd, opts) => {
      const isCheck = cmd[0] === process.execPath && cmd[1] === "-e" && cmd[2] === "setTimeout(() => {}, 80)";
      if (isCheck) {
        active++;
        maxActive = Math.max(maxActive, active);
      }
      try {
        return await localExec(cmd, opts);
      } finally {
        if (isCheck) active--;
      }
    };
    const report = await runOracleGate(trackedExec, candidates, {
      repoRoot: repo,
      projectDir: "app",
      checks: [{ name: "delay", command: () => [process.execPath, "-e", "setTimeout(() => {}, 80)"] }],
      bestConcurrency: 2,
      scratchRoot: join(root, "scratch"),
    });

    assert.equal(maxActive, 2);
    assert.deepEqual(report.verdicts.map((v) => v.id), candidates.map((c) => c.id));
    assert.deepEqual(report.landed.length, 1);
  } finally {
    cleanup();
  }
});

test("scratch copies tracked changes through an in-VM diff stream", { timeout: 30_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  const commands: string[][] = [];
  let scratch: Awaited<ReturnType<typeof createScratch>> | undefined;
  try {
    const changed = `${MATH}export const dirty = true;\n`;
    writeFileSync(join(repo, "app/src/math.ts"), changed);
    const recordingExec: OracleExec = (cmd, opts) => {
      commands.push(cmd);
      return localExec(cmd, opts);
    };
    scratch = await createScratch(recordingExec, { repoRoot: repo, scratchRoot: join(root, "scratch") });

    assert.ok(commands.some((cmd) => cmd[0] === "bash" && cmd.join(" ").includes("git -C \"$1\" diff --binary HEAD | git -C \"$2\" apply --allow-empty")));
    assert.equal(readFileSync(join(scratch.dir, "app/src/math.ts"), "utf8"), changed);
  } finally {
    await scratch?.dispose();
    cleanup();
  }
});

test("best mode refuses to land when the real workspace changed after scratch creation", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const candidate = { id: "stale", diff: diffFor(repo, { "app/src/new.ts": "export const value = 1;\n" }) };
    let changedRealWorkspace = false;
    const mutatingExec: OracleExec = async (cmd, opts) => {
      if (!changedRealWorkspace && cmd[0] === process.execPath && cmd[1] === "-e" && cmd[3] === "mutate-workspace") {
        changedRealWorkspace = true;
        writeFileSync(join(repo, "app/src/unrelated.ts"), "export const external = true;\n");
      }
      return localExec(cmd, opts);
    };
    const report = await runOracleGate(mutatingExec, [candidate], {
      repoRoot: repo,
      projectDir: "app",
      checks: [{ name: "mutate", command: () => [process.execPath, "-e", "process.exit(0)", "mutate-workspace"] }],
      scratchRoot: join(root, "scratch"),
    });

    assert.equal(changedRealWorkspace, true);
    assert.deepEqual(report.landed, []);
    assert.equal(report.verdicts[0].status, "error");
    assert.equal(report.verdicts[0].status === "error" && report.verdicts[0].stage, "land");
    assert.ok(!existsSync(join(repo, "app/src/new.ts")));
  } finally {
    cleanup();
  }
});

test("candidate inspection batches affected-test and retry-definition file reads", { timeout: 30_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const candidate = { id: "batch", diff: diffFor(repo, { "app/src/math.ts": MATH.replace("a + b", "a - b") }) };
    const batchReadCommands: string[][] = [];
    const recordingExec: OracleExec = (cmd, opts) => {
      if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2].includes("for file do") && cmd[2].includes("base64")) batchReadCommands.push(cmd);
      return localExec(cmd, opts);
    };
    const report = await runOracleGate(recordingExec, [candidate], {
      repoRoot: repo,
      projectDir: "app",
      checks: [{ name: "reject", command: () => [process.execPath, "-e", "process.exit(1)"] }],
      scratchRoot: join(root, "scratch"),
    });

    assert.equal(report.verdicts[0].status, "rejected");
    assert.equal(batchReadCommands.length, 2, "one batch for affected tests and one for retry definitions");
  } finally {
    cleanup();
  }
});

test("unsafe paths are rejected before any scratch is made; environment errors fail closed", async () => {
  const calls: string[][] = [];
  const recording: OracleExec = async (cmd) => {
    calls.push(cmd);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const evil = "diff --git a/../etc/passwd b/../etc/passwd\n--- a/../etc/passwd\n+++ b/../etc/passwd\n@@ -1 +1 @@\n-x\n+y\n";
  const report = await runOracleGate(recording, [{ id: "evil", diff: evil }], { repoRoot: "/nowhere", checks: [] });
  assert.equal(report.verdicts[0].status === "rejected" && report.verdicts[0].stage, "safety");
  assert.ok(!calls.some((c) => c.includes("worktree")), "no scratch for an unsafe patch");

  const failing: OracleExec = async (cmd) =>
    cmd.includes("worktree") ? { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" } : { exitCode: 0, stdout: "", stderr: "" };
  const logs: string[] = [];
  const errored = await runOracleGate(
    failing,
    [{ id: "ok", diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n" }],
    { repoRoot: "/nowhere", checks: [], log: (l) => logs.push(l) },
  );
  assert.equal(errored.verdicts[0].status, "error");
  assert.deepEqual(errored.landed, []);
  assert.ok(logs.includes("oracle: 1/1 candidates rejected; nothing landed"));

  const throwing: OracleExec = async () => {
    throw new Error("exec channel closed");
  };
  const thrown = await runOracleGate(
    throwing,
    [{ id: "t", diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n" }],
    { repoRoot: "/nowhere", checks: [] },
  );
  assert.equal(thrown.verdicts[0].status, "error");
  assert.deepEqual(thrown.landed, []);
});

test("parsePatchFiles reads git and plain diffs, renames, adds and deletes", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "--- this removed line looks like a header",
    "+++ and so does this added one",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+x",
    "diff --git a/src/old.ts b/src/old.ts",
    "deleted file mode 100644",
    "--- a/src/old.ts",
    "+++ /dev/null",
    "diff --git a/src/r1.ts b/src/r2.ts",
    "similarity index 100%",
    "rename from src/r1.ts",
    "rename to src/r2.ts",
  ].join("\n");
  assert.deepEqual(parsePatchFiles(diff), [
    { path: "src/a.ts", status: "M" },
    { path: "src/new.ts", status: "A" },
    { path: "src/old.ts", status: "D" },
    { path: "src/r2.ts", status: "R", oldPath: "src/r1.ts" },
  ]);
  assert.deepEqual(parsePatchFiles("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/y.ts\n@@ -0,0 +1 @@\n+c\n"), [
    { path: "x.ts", status: "M" },
    { path: "y.ts", status: "A" },
  ]);
  assert.deepEqual(parsePatchFiles(""), []);
  assert.deepEqual(unsafePatchPaths([{ path: "/etc/x", status: "M" }, { path: "a/../../b", status: "M" }, { path: ".git/config", status: "M" }, { path: "ok.ts", status: "M" }]), [
    "/etc/x",
    "a/../../b",
    ".git/config",
  ]);
  assert.equal(countChurn("--- a/x\n+++ b/x\n@@\n-a\n+b\n+c\n context\n"), 3);
});

test("parsePatchFiles captures every declared path; unsafePatchPaths rejects traversal, .git and symlinks", () => {
  // Mismatched git header vs +++ header: the escaping +++ path must surface.
  const mismatched = [
    "diff --git a/src/safe.ts b/src/safe.ts",
    "--- a/src/safe.ts",
    "+++ b/../outside.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const mismatchedFiles = parsePatchFiles(mismatched);
  assert.ok(
    mismatchedFiles.some((f) => f.path === "../outside.ts"),
    `the +++ path must be captured: ${JSON.stringify(mismatchedFiles)}`,
  );
  assert.deepEqual(unsafePatchPaths(mismatchedFiles), ["../outside.ts"]);

  // Mismatched git header a-side vs b-side.
  const aside = parsePatchFiles(
    "diff --git a/../outside.ts b/src/safe.ts\n--- a/../outside.ts\n+++ b/src/safe.ts\n@@ -1 +1 @@\n-x\n+y\n",
  );
  assert.deepEqual(unsafePatchPaths(aside), ["../outside.ts"]);

  // A --- header naming an escaping path inside a git section.
  const dashDash = parsePatchFiles(
    "diff --git a/src/safe.ts b/src/safe.ts\n--- a/../outside.ts\n+++ b/src/safe.ts\n@@ -1 +1 @@\n-x\n+y\n",
  );
  assert.deepEqual(unsafePatchPaths(dashDash), ["../outside.ts"]);

  // A rename target that escapes, while the git header looks benign.
  const renamed = [
    "diff --git a/src/r1.ts b/src/r2.ts",
    "similarity index 100%",
    "rename from src/r1.ts",
    "rename to ../outside.ts",
  ].join("\n");
  assert.deepEqual(unsafePatchPaths(parsePatchFiles(renamed)), ["../outside.ts"]);

  // .git in any normalized segment, any case.
  for (const p of ["./.git/config", ".GIT/config", "sub/.git/hooks/post-commit", "a/.Git/x"]) {
    assert.deepEqual(unsafePatchPaths([{ path: p, status: "M" }]), [p], p);
  }
  // .git as a substring of a longer name is fine.
  assert.deepEqual(unsafePatchPaths([{ path: "src/.github/workflows.ts", status: "M" }]), []);
  assert.deepEqual(unsafePatchPaths([{ path: "src/agitator.ts", status: "M" }]), []);

  // NUL / control characters.
  assert.deepEqual(unsafePatchPaths([{ path: "src/a\0b.ts", status: "M" }]), ["src/a\0b.ts"]);
  assert.deepEqual(unsafePatchPaths([{ path: "src/a\nb.ts", status: "M" }]), ["src/a\nb.ts"]);

  // Symlink modes: new file, and a mode change to 120000.
  const symlinkNew = [
    "diff --git a/src/link.ts b/src/link.ts",
    "new file mode 120000",
    "--- /dev/null",
    "+++ b/src/link.ts",
    "@@ -0,0 +1 @@",
    "+src/real.ts",
  ].join("\n");
  const newFiles = parsePatchFiles(symlinkNew);
  assert.equal(newFiles[0]?.symlink, true);
  assert.deepEqual(unsafePatchPaths(newFiles), ["src/link.ts (symlink)"]);

  const symlinkMode = [
    "diff --git a/src/link.ts b/src/link.ts",
    "old mode 100644",
    "new mode 120000",
    "--- a/src/link.ts",
    "+++ b/src/link.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  assert.deepEqual(unsafePatchPaths(parsePatchFiles(symlinkMode)), ["src/link.ts (symlink)"]);

  // A normal mode change (100644 -> 100755) is not a symlink.
  const modeChange = [
    "diff --git a/src/run.sh b/src/run.sh",
    "old mode 100644",
    "new mode 100755",
    "--- a/src/run.sh",
    "+++ b/src/run.sh",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const modeFiles = parsePatchFiles(modeChange);
  assert.equal(modeFiles[0]?.symlink, undefined);
  assert.deepEqual(unsafePatchPaths(modeFiles), []);

  // Quoted paths with escaped quotes, and unquoted paths with spaces.
  const quoted = parsePatchFiles(
    'diff --git "a/fi\\"le.ts" "b/fi\\"le.ts"\n--- "a/fi\\"le.ts"\n+++ "b/fi\\"le.ts"\n@@ -1 +1 @@\n-x\n+y\n',
  );
  assert.deepEqual(quoted, [{ path: 'fi"le.ts', status: "M" }]);
  const spaced = parsePatchFiles(
    "diff --git a/my file.ts b/my file.ts\n--- a/my file.ts\n+++ b/my file.ts\n@@ -1 +1 @@\n-x\n+y\n",
  );
  assert.deepEqual(spaced, [{ path: "my file.ts", status: "M" }]);

  // copy from/to is captured as an add with the source as oldPath.
  const copied = [
    "diff --git a/src/orig.ts b/src/copy.ts",
    "similarity index 100%",
    "copy from src/orig.ts",
    "copy to src/copy.ts",
  ].join("\n");
  assert.deepEqual(parsePatchFiles(copied), [{ path: "src/copy.ts", status: "A", oldPath: "src/orig.ts" }]);
});

test("findAffectedTests: changed tests, siblings and importers only", () => {
  const files: Record<string, string> = {
    "lib/a.test.ts": 'import { a } from "./a";',
    "lib/a.extra.test.ts": "",
    "lib/b.test.ts": 'import { b } from "./b";',
    "lib/deep/c.test.ts": 'import { a } from "../a.js";',
    "lib/deep/d.test.ts": 'import x from "../../other";',
  };
  const affected = findAffectedTests({
    changed: [{ path: "lib/a.ts", status: "M" }, { path: "lib/b.test.ts", status: "M" }, { path: "lib/gone.test.ts", status: "D" }],
    allTests: Object.keys(files),
    readFile: (p) => files[p],
  });
  assert.deepEqual(affected, ["lib/a.extra.test.ts", "lib/a.test.ts", "lib/b.test.ts", "lib/deep/c.test.ts"]);
  assert.deepEqual(relativeImports('import a from "./x";\nexport * from "../y";\nconst z = await import("./z");\nimport "pkg";'), ["./x", "../y", "./z"]);
  assert.equal(resolveSpecifier("lib/deep/c.test.ts", "../a.js"), "lib/a");
});

test("findAffectedTests: directory index imports and transitive callers", () => {
  const files: Record<string, string> = {
    "lib/deep/x.test.ts": 'import x from "..";',
    "lib/consumer.test.ts": 'import { w } from "./wrapper";',
    "lib/wrapper.ts": 'import { thing } from ".";',
    "lib/unrelated.test.ts": 'import { z } from "./z";',
  };
  const affected = findAffectedTests({
    changed: [{ path: "lib/index.ts", status: "M" }],
    allTests: Object.keys(files).filter((p) => p.endsWith(".test.ts")),
    readFile: (p) => files[p],
  });
  assert.deepEqual(affected, ["lib/consumer.test.ts", "lib/deep/x.test.ts"]);
  assert.deepEqual(relativeImports('import a from ".";\nimport b from "..";\nimport c from "./x";'), [".", "..", "./x"]);
  assert.equal(resolveSpecifier("lib/deep/x.test.ts", ".."), "lib");
  assert.ok(TRANSITIVE_HOPS >= 2);
});

test("definitionSources loads the changed file and its direct relative imports", async () => {
  const { repo, cleanup } = makeRepo();
  try {
    writeFileSync(join(repo, "app/src/uses.ts"), 'import { add } from "./math";\nexport const total = add(1, 2);\n');
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "add uses");
    const gate = new OracleGate(localExec, { repoRoot: join(repo, "app") });
    const sources = await (
      gate as unknown as {
        definitionSources: (files: PatchFile[]) => Promise<{ path: string; content: string }[]>;
      }
    ).definitionSources([{ path: "src/uses.ts", status: "M" }]);
    assert.deepEqual(sources.map((s) => s.path).sort(), ["src/math.ts", "src/uses.ts"]);
    assert.match(sources.find((s) => s.path === "src/math.ts")!.content, /function add/);
  } finally {
    cleanup();
  }
});

test("diagnostics are trimmed to error lines, redacted and bounded", () => {
  const out = [
    "noise",
    "src/a.ts(3,5): error TS2339: Property 'size' does not exist on type 'Pool'.",
    "  more context",
    "token sk-ant-api03-FAKE-ANTHROPIC-KEY-0123456789 leaked",
    "Error: boom",
  ].join("\n");
  const d = extractDiagnostic(out);
  assert.match(d, /error TS2339/);
  assert.match(d, /more context/);
  assert.doesNotMatch(d, /noise/);
  assert.doesNotMatch(d, /sk-ant-api03-FAKE/);
  assert.ok(extractDiagnostic("x".repeat(10_000), 500).length < 600);
  assert.deepEqual(diagnosticSymbols(d).slice(0, 2), ["Pool", "size"]);

  const def = findDefinition("Pool", [{ path: "src/pool.ts", content: "// x\nexport class Pool {\n  items = [];\n}\nconst y = 1;" }]);
  assert.deepEqual(def && [def.startLine, def.endLine], [2, 4]);
  const ctx = buildRetryContext({ stage: "tsc", diagnostic: d, files: [{ path: "src/pool.ts", content: "export class Pool {\n}\n" }] });
  assert.match(ctx, /Definition of `Pool` \(src\/pool\.ts:L1-2\)/);
});

test("findDefinition ignores braces in strings/comments and escapes regex metacharacters", () => {
  const source = [
    "export function tricky() {",
    '  const s = "{ fake }";',
    "  // } a closing brace in a line comment",
    "  /* { an opening brace in a block comment } */",
    "  const t = `} template brace`;",
    "  return 1;",
    "}",
    "export function next() {}",
  ].join("\n");
  const files = [{ path: "x.ts", content: source }];
  const def = findDefinition("tricky", files);
  assert.deepEqual(def && [def.startLine, def.endLine], [1, 7]);
  // Names containing regex metacharacters must not throw or match loosely.
  assert.equal(findDefinition("tri.ky", files), null);
  assert.equal(findDefinition("tricky[", files), null);
  assert.ok(findDefinition("next", files));
});

test("extractDiagnostic strips non-SGR ANSI sequences", () => {
  const out = "\x1b[2K\x1b[31mError: boom\x1b[0m\x1b]0;a title\x07";
  const d = extractDiagnostic(out);
  assert.match(d, /Error: boom/);
  assert.doesNotMatch(d, /\x1B/);
});

test("writeFileViaExec round-trips content through argv-only base64 chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oracle-write-"));
  try {
    const file = join(dir, "p.diff");
    const content = "héllo $HOME `x` \"q\" 'q'\n".repeat(10_000);
    await writeFileViaExec(localExec, file, content);
    assert.equal(readFileSync(file, "utf8"), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mode 'first' lands the first passer, skips the rest, and can commit it", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const a = diffFor(repo, { "app/src/math.ts": MATH + "export const a = 1;\n" });
    const b = diffFor(repo, { "app/src/math.ts": MATH + "export const b = 2;\n" });
    const report = await runOracleGate(
      localExec,
      [
        { id: "a", diff: a },
        { id: "b", diff: b },
      ],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, mode: "first", commitMessage: "oracle: land a", scratchRoot: join(root, "scratch") },
    );
    assert.deepEqual(report.landed, ["a"]);
    assert.equal(report.verdicts[1].status, "skipped");
    assert.equal(git(repo, "log", "-1", "--format=%s").trim(), "oracle: land a");
    assert.equal(git(repo, "status", "--porcelain"), "");
  } finally {
    cleanup();
  }
});

test("defaultOracleChecks: tsc always, eslint on changed sources, tsx --test on affected tests", () => {
  const [tsc, lint, tests] = defaultOracleChecks({ testEnv: { SWARM_HOME: "/tmp/h" } });
  const ctx = { cwd: "/s/app", scratchDir: "/s", changedFiles: ["lib/a.ts", "README.md"], affectedTests: ["lib/a.test.ts"] };
  assert.deepEqual(tsc.command(ctx), ["npx", "--no-install", "tsc", "--noEmit", "--incremental", "false"]);
  assert.deepEqual(lint.command(ctx), ["npx", "--no-install", "eslint", "--no-warn-ignored", "--", "lib/a.ts"]);
  assert.deepEqual(tests.command(ctx), ["env", "SWARM_HOME=/tmp/h", "npx", "--no-install", "tsx", "--test", "--test-concurrency=4", "lib/a.test.ts"]);
  assert.equal(lint.command({ ...ctx, changedFiles: ["docs/x.md"] }), null);
  assert.equal(tests.command({ ...ctx, affectedTests: [] }), null);
});

test("unsafePatchPaths rejects .git in any path segment, case-insensitively, and ignores lookalikes", () => {
  assert.deepEqual(
    unsafePatchPaths([
      { path: "sub/.git/config", status: "M" },
      { path: "./.git/hooks/pre-commit", status: "M" },
      { path: "a/b/.GIT/config", status: "M" },
      { path: "x/.git", status: "M" },
      { path: ".gitignore", status: "M" },
      { path: "lib/.github/workflows/ci.yml", status: "M" },
      { path: "ok.ts", status: "M" },
    ]),
    ["sub/.git/config", "./.git/hooks/pre-commit", "a/b/.GIT/config", "x/.git"],
  );
});

test("parsePatchFiles handles unquoted paths with spaces via the ---/+++ headers", () => {
  const diff = [
    "diff --git a/lib/my file.ts b/lib/my file.ts",
    "index 1..2 100644",
    "--- a/lib/my file.ts",
    "+++ b/lib/my file.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/lib/old name.ts b/lib/new name.ts",
    "similarity index 100%",
    "rename from lib/old name.ts",
    "rename to lib/new name.ts",
    "diff --git a/my b/file.ts b/my b/file.ts",
    "index 1..2 100644",
    "--- a/my b/file.ts",
    "+++ b/my b/file.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
  assert.deepEqual(parsePatchFiles(diff), [
    { path: "lib/my file.ts", status: "M" },
    { path: "lib/new name.ts", status: "R", oldPath: "lib/old name.ts" },
    // "my b/file.ts" contains " b/" itself, so only the +++ header gets it right.
    { path: "my b/file.ts", status: "M" },
  ]);
});

test("parsePatchFiles flags symlink diffs and unsafePatchPaths rejects them", () => {
  const diff = [
    "diff --git a/src/link.ts b/src/link.ts",
    "new file mode 120000",
    "--- /dev/null",
    "+++ b/src/link.ts",
    "@@ -0,0 +1 @@",
    "+/etc/passwd",
    "diff --git a/src/old-link.ts b/src/target.ts",
    "old mode 120000",
    "new mode 100644",
    "--- a/src/old-link.ts",
    "+++ b/src/target.ts",
  ].join("\n");
  const files = parsePatchFiles(diff);
  assert.deepEqual(files, [
    { path: "src/link.ts", status: "A", symlink: true },
    { path: "src/target.ts", status: "M", symlink: true },
  ]);
  assert.deepEqual(unsafePatchPaths(files), ["src/link.ts (symlink)", "src/target.ts (symlink)"]);
});

test("a symlink patch is rejected at safety before any scratch is made", async () => {
  const calls: string[][] = [];
  const recording: OracleExec = async (cmd) => {
    calls.push(cmd);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const link = [
    "diff --git a/src/link.ts b/src/link.ts",
    "new file mode 120000",
    "--- /dev/null",
    "+++ b/src/link.ts",
    "@@ -0,0 +1 @@",
    "+/etc/passwd",
  ].join("\n");
  const report = await runOracleGate(recording, [{ id: "link", diff: link }], { repoRoot: "/nowhere", checks: [] });
  const v = report.verdicts[0];
  assert.equal(v.status === "rejected" && v.stage, "safety");
  assert.match(v.status === "rejected" ? v.diagnostic : "", /symlink/);
  assert.ok(!calls.some((c) => c.includes("worktree")), "no scratch for a symlink patch");
});

test("a barrel index.ts change runs tests that import the barrel by directory", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    // lib/router/index.ts is the barrel; pages.test.ts imports "./router"
    // and never mentions the word "index", so the old basename-only
    // pre-filter silently skipped it and the broken patch landed.
    mkdirSync(join(repo, "app/src/router"), { recursive: true });
    writeFileSync(join(repo, "app/src/router/index.ts"), 'export function getRoute(): string {\n  return "/home";\n}\n');
    writeFileSync(
      join(repo, "app/src/pages.test.ts"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { getRoute } from "./router";',
        "",
        'test("pages use the home route", () => {',
        '  assert.equal(getRoute(), "/home");',
        "});",
        "",
      ].join("\n"),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "router barrel");
    const broken = diffFor(repo, {
      "app/src/router/index.ts": 'export function getRoute(): string {\n  return "/wrong";\n}\n',
    });
    const report = await runOracleGate(
      localExec,
      [{ id: "barrel", diff: broken }],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, scratchRoot: join(root, "scratch") },
    );
    const v = report.verdicts[0];
    assert.equal(v.status, "rejected");
    assert.equal(v.status === "rejected" && v.stage, "tests");
    assert.deepEqual(report.landed, []);
    assert.match(readFileSync(join(repo, "app/src/router/index.ts"), "utf8"), /"\/home"/);
  } finally {
    cleanup();
  }
});

test("mode 'best' falls back to the next passing candidate when the winner cannot land", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const small = diffFor(repo, { "app/src/math.ts": MATH + "export const z = 0;\n" });
    const big = diffFor(repo, { "app/src/math.ts": MATH + "export const z = 0;\nexport const y = 1;\nexport const x = 2;\n" });
    // The first land check (the winner's) fails; the next candidate lands.
    let landChecks = 0;
    const flaky: OracleExec = async (cmd, opts) => {
      if (cmd[0] === "git" && cmd.includes("apply") && cmd.includes("--check")) {
        landChecks++;
        if (landChecks === 1) return { exitCode: 1, stdout: "", stderr: "error: patch does not apply" };
      }
      return localExec(cmd, opts);
    };
    const report = await runOracleGate(
      flaky,
      [
        { id: "big", diff: big },
        { id: "small", diff: small },
      ],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, scratchRoot: join(root, "scratch") },
    );
    assert.deepEqual(report.landed, ["big"]);
    assert.equal(report.rejected, 1);
    const smallVerdict = report.verdicts.find((v) => v.id === "small");
    assert.equal(smallVerdict?.status, "error");
    assert.equal(smallVerdict?.status === "error" && smallVerdict.stage, "land");
    assert.match(smallVerdict?.status === "error" ? smallVerdict.retryContext ?? "" : "", /real tree rejected the patch/);
    assert.match(readFileSync(join(repo, "app/src/math.ts"), "utf8"), /export const x = 2;/);
  } finally {
    cleanup();
  }
});

test("when nothing lands, the report's retryContext comes from the land error", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const good = diffFor(repo, { "app/src/math.ts": MATH + "export const z = 0;\n" });
    // Every land check fails: the tree rejects the patch after it passed.
    const noLand: OracleExec = async (cmd, opts) => {
      if (cmd[0] === "git" && cmd.includes("apply") && cmd.includes("--check")) {
        return { exitCode: 1, stdout: "", stderr: "error: patch does not apply" };
      }
      return localExec(cmd, opts);
    };
    const report = await runOracleGate(
      noLand,
      [{ id: "only", diff: good }],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, mode: "best", scratchRoot: join(root, "scratch") },
    );
    assert.deepEqual(report.landed, []);
    assert.equal(report.verdicts[0].status, "error");
    assert.equal(report.verdicts[0].status === "error" && report.verdicts[0].stage, "land");
    assert.match(report.retryContext ?? "", /rejected by the oracle at "land"/);
    assert.match(report.retryContext ?? "", /real tree rejected the patch/);
  } finally {
    cleanup();
  }
});

test("mode 'best' with duplicate candidate ids lands the patch once", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const diff = diffFor(repo, { "app/src/math.ts": MATH + "export const z = 0;\n" });
    const report = await runOracleGate(
      localExec,
      [
        { id: "dup", diff },
        { id: "dup", diff },
      ],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, scratchRoot: join(root, "scratch") },
    );
    assert.deepEqual(report.landed, ["dup"]);
    assert.equal(report.rejected, 0);
    const second = report.verdicts[1];
    assert.equal(second.status, "passed");
    assert.equal(second.status === "passed" && second.landed, false);
    assert.match(second.status === "passed" ? second.note ?? "" : "", /has less churn/);
    assert.equal(readFileSync(join(repo, "app/src/math.ts"), "utf8").match(/export const z = 0;/g)?.length, 1);
  } finally {
    cleanup();
  }
});

test("a throwing apply leaves no .candidate.patch file behind", { timeout: 60_000 }, async () => {
  const { root, repo, cleanup } = makeRepo();
  try {
    const scratchRoot = join(root, "scratch");
    const good = diffFor(repo, { "app/src/math.ts": MATH + "export const z = 0;\n" });
    // The apply throws instead of returning a non-zero exit: the old code
    // skipped its rm and leaked `${scratch.dir}.candidate.patch`.
    const throwing: OracleExec = async (cmd, opts) => {
      if (cmd[0] === "git" && cmd.includes("apply") && !cmd.includes("--check")) {
        throw new Error("apply exploded");
      }
      return localExec(cmd, opts);
    };
    const report = await runOracleGate(
      throwing,
      [{ id: "t", diff: good }],
      { repoRoot: repo, projectDir: "app", checks: CHECKS, scratchRoot },
    );
    assert.equal(report.verdicts[0].status, "error");
    assert.deepEqual(report.landed, []);
    const leftovers = existsSync(scratchRoot) ? readdirSync(scratchRoot) : [];
    assert.deepEqual(
      leftovers.filter((f) => f.endsWith(".candidate.patch")),
      [],
    );
  } finally {
    cleanup();
  }
});

test("execWithTimeout settles a post-timeout abort as the timeout result, never an unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => {
    rejections.push(err);
  };
  process.on("unhandledRejection", onRejection);
  try {
    const exec: OracleExec = (_cmd, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted after timeout")), { once: true });
      });
    const res = await execWithTimeout(exec, ["sleep", "10"], { timeoutMs: 20 });
    assert.equal(res.timedOut, true);
    assert.equal(res.exitCode, 124);
    // Give the late rejection a chance to surface if it is unhandled.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("execWithTimeout still propagates a rejection that arrives before the timeout", async () => {
  const exec: OracleExec = async () => {
    throw new Error("boom before timeout");
  };
  await assert.rejects(execWithTimeout(exec, ["x"], { timeoutMs: 1000 }), /boom before timeout/);
});
