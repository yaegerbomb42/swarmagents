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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOracleChecks, runOracleGate, type OracleCheck, type OracleExec } from "./oracle";
import { countChurn, parsePatchFiles, unsafePatchPaths } from "./diff";
import { findAffectedTests, relativeImports, resolveSpecifier } from "./affected";
import { buildRetryContext, diagnosticSymbols, extractDiagnostic, findDefinition } from "./retry";
import { writeFileViaExec } from "./exec";

const APP = process.cwd();
const TSC = join(APP, "node_modules/typescript/bin/tsc");
const TSX = join(APP, "node_modules/tsx/dist/cli.mjs");

/**
 * Child env for the local exec. NODE_TEST_CONTEXT is dropped: node:test sets
 * it for its own children, and a nested `--test` run would then report to
 * this runner instead of exiting non-zero on failure (the VM exec never has it).
 */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));

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
    assert.equal(report.verdicts[0].status === "rejected" && report.verdicts[0].stage, "apply");
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
  assert.deepEqual(unsafePatchPaths(newFiles), ["src/link.ts"]);

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
  assert.deepEqual(unsafePatchPaths(parsePatchFiles(symlinkMode)), ["src/link.ts"]);

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
  assert.deepEqual(tests.command(ctx), ["env", "SWARM_HOME=/tmp/h", "npx", "--no-install", "tsx", "--test", "--test-concurrency=1", "lib/a.test.ts"]);
  assert.equal(lint.command({ ...ctx, changedFiles: ["docs/x.md"] }), null);
  assert.equal(tests.command({ ...ctx, affectedTests: [] }), null);
});
