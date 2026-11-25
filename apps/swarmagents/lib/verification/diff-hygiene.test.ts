import test from "node:test";
import assert from "node:assert/strict";
import {
  SAFETY_DENYLIST,
  checkDiffHygiene,
  findChangedAssertions,
  matchesDenylist,
  scanDiffForSecrets,
} from "./diff-hygiene.js";
import { runRevertProof, type RevertProofInput } from "./revert-proof.js";
import type { ShadowExec, ShadowExecResult } from "./shadow-verifier.js";

/**
 * Tests for the Stage 0 diff-hygiene port and the Stage 3 revert-test proof.
 *
 * NOTE on the AST layer: these tests run against the TEMPORARY regex-based
 * `ast-analysis.ts` stub (see that file's banner). The fixtures use simple
 * `test("title", ...)` + `expect(...).toBe(<literal>)` shapes the stub
 * parses. After the sibling worker's real `ast-analysis.ts` port lands, the
 * coordinator must re-run this file — the assertions are written against
 * the contracted semantics, not stub internals.
 */

const ADDER_HEAD = `import { add } from "./adder";

test("adds two numbers", () => {
  expect(add(2, 3)).toBe(5);
});
`;

const ADDER_WEAKENED = `import { add } from "./adder";

test("adds two numbers", () => {
  expect(add(2, 3)).toBe(6);
});
`;

const ADDER_EXTENDED = `import { add } from "./adder";

test("adds two numbers", () => {
  expect(add(2, 3)).toBe(5);
});

test("adds negatives", () => {
  expect(add(-1, -2)).toBe(-3);
});
`;

const ADDER_SKIPPED = `import { add } from "./adder";

test.skip("adds two numbers", () => {
  expect(add(2, 3)).toBe(5);
});
`;

const SECRET_DIFF = [
  "diff --git a/lib/foo.ts b/lib/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/lib/foo.ts",
  "+++ b/lib/foo.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "+const key = \"sk-ant-api03-abcdefghij1234567890\";",
  " const b = 2;",
].join("\n");

// --- Stage 0: denylist -------------------------------------------------------

test("denylist rejects repo-forbidden paths and allows ordinary source", () => {
  assert.ok(matchesDenylist("api_keys.md", SAFETY_DENYLIST));
  assert.ok(matchesDenylist("lib/.env.local", SAFETY_DENYLIST));
  assert.ok(matchesDenylist(".env", SAFETY_DENYLIST));
  assert.ok(matchesDenylist("certs/server.pem", SAFETY_DENYLIST));
  assert.ok(matchesDenylist("certs/server.key", SAFETY_DENYLIST));
  assert.ok(matchesDenylist("node_modules/foo/index.js", SAFETY_DENYLIST));
  assert.ok(matchesDenylist("coverage/lcov.info", SAFETY_DENYLIST));
  assert.ok(matchesDenylist(".next/server/app/page.js", SAFETY_DENYLIST));
  assert.ok(matchesDenylist("dist/bundle.js", SAFETY_DENYLIST));
  assert.ok(matchesDenylist(".github/workflows/ci.yml", SAFETY_DENYLIST));
  assert.ok(matchesDenylist("package-lock.json", SAFETY_DENYLIST));
  assert.ok(matchesDenylist("apps/swarmagents/yarn.lock", SAFETY_DENYLIST));
  assert.equal(matchesDenylist("lib/adder.ts", SAFETY_DENYLIST), undefined);
  assert.equal(matchesDenylist("lib/adder.test.ts", SAFETY_DENYLIST), undefined);
});

test("checkDiffHygiene rejects forbidden-path diffs with one violation per file", () => {
  const result = checkDiffHygiene({
    diff: "",
    changedFiles: ["api_keys.md", "lib/adder.ts", ".env"],
  });
  assert.equal(result.clean, false);
  assert.match(result.violations.join("\n"), /api_keys\.md/);
  assert.match(result.violations.join("\n"), /\.env/);
  assert.doesNotMatch(result.violations.join("\n"), /adder\.ts/);
});

// --- Stage 0: secret scan ----------------------------------------------------

test("secret scan flags a key on an added line with the right file and line", () => {
  const findings = scanDiffForSecrets(SECRET_DIFF);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "lib/foo.ts");
  assert.equal(findings[0]?.line, 2);
  assert.match(findings[0]?.reason ?? "", /Anthropic API key/);
});

test("secret scan ignores removed lines and context lines", () => {
  const diff = [
    "diff --git a/lib/foo.ts b/lib/foo.ts",
    "--- a/lib/foo.ts",
    "+++ b/lib/foo.ts",
    "@@ -1,2 +1,2 @@",
    "-const key = \"sk-ant-api03-abcdefghij1234567890\";",
    " const a = 1;",
  ].join("\n");
  assert.deepEqual(scanDiffForSecrets(diff), []);
});

test("checkDiffHygiene surfaces the secret-scan finding as a violation", () => {
  const result = checkDiffHygiene({ diff: SECRET_DIFF, changedFiles: ["lib/foo.ts"] });
  assert.equal(result.clean, false);
  assert.match(result.violations.join("\n"), /secret in lib\/foo\.ts:2/);
});

// --- Stage 0: weakened expectations ------------------------------------------

test("findChangedAssertions reports a changed expected value and a removal, not an addition", () => {
  const changed = findChangedAssertions(ADDER_HEAD, ADDER_WEAKENED, "lib/adder.test.ts");
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.testTitle, "adds two numbers");
  assert.equal(changed[0]?.matcher, "toBe");
  assert.equal(changed[0]?.before, "5");
  assert.equal(changed[0]?.after, "6");

  const added = findChangedAssertions(ADDER_HEAD, ADDER_EXTENDED, "lib/adder.test.ts");
  assert.deepEqual(added, []);

  const removed = findChangedAssertions(
    ADDER_HEAD,
    `import { add } from "./adder";\n`,
    "lib/adder.test.ts",
  );
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.after, null);
});

test("weakened expectation with no source fix is a violation", () => {
  const result = checkDiffHygiene({
    diff: "",
    changedFiles: ["lib/adder.test.ts"],
    readFile: () => ADDER_WEAKENED,
    readHeadFile: () => ADDER_HEAD,
  });
  assert.equal(result.clean, false);
  assert.match(result.violations.join("\n"), /weakened test expectation/);
  assert.match(result.violations.join("\n"), /toBe\(5\)|expected 5 → 6/);
});

test("weakened expectation with a fix to the source under test passes", () => {
  const result = checkDiffHygiene({
    diff: "",
    changedFiles: ["lib/adder.test.ts", "lib/adder.ts"],
    readFile: (p) => (p === "lib/adder.test.ts" ? ADDER_WEAKENED : "export function add() {}"),
    readHeadFile: () => ADDER_HEAD,
  });
  assert.equal(result.clean, true);
  assert.deepEqual(result.violations, []);
});

test("test-only diff rewriting expectations is rejected; pure additions pass", () => {
  const rewritten = checkDiffHygiene({
    diff: "",
    changedFiles: ["lib/adder.test.ts"],
    readFile: () => ADDER_WEAKENED,
    readHeadFile: () => ADDER_HEAD,
  });
  assert.match(rewritten.violations.join("\n"), /test-only diff rewrites 1 existing test expectation/);

  const added = checkDiffHygiene({
    diff: "",
    changedFiles: ["lib/adder.test.ts"],
    readFile: () => ADDER_EXTENDED,
    readHeadFile: () => ADDER_HEAD,
  });
  assert.equal(added.clean, true);
});

test("added .skip in a changed test file is a violation", () => {
  const result = checkDiffHygiene({
    diff: "",
    changedFiles: ["lib/adder.test.ts"],
    readFile: () => ADDER_SKIPPED,
    readHeadFile: () => ADDER_HEAD,
  });
  assert.equal(result.clean, false);
  assert.match(result.violations.join("\n"), /\.skip/);
});

test("assertion count falling below the HEAD baseline is a violation", () => {
  const result = checkDiffHygiene({
    diff: "",
    changedFiles: ["lib/adder.test.ts"],
    baselineAssertionCount: 2,
    readFile: () => ADDER_HEAD, // 1 assertion
    readHeadFile: () => ADDER_HEAD,
  });
  assert.equal(result.clean, false);
  assert.match(result.violations.join("\n"), /assertion count in changed tests fell 2 → 1/);
});

test("checkDiffHygiene catches multi-language skip and suppression markers in unified diffs", () => {
  const diff = [
    "+++ b/tests/test_api.py",
    "+@pytest.mark.skip(reason='flaky')",
    "+++ b/lib/foo.ts",
    "+// @ts-ignore",
  ].join("\n");
  const result = checkDiffHygiene({
    diff,
    changedFiles: ["tests/test_api.py", "lib/foo.ts"],
  });
  assert.equal(result.clean, false);
  assert.match(result.violations.join("\n"), /@pytest\.mark\.skip/);
  assert.match(result.violations.join("\n"), /@ts-ignore/);
});

test("checkDiffHygiene rejects deleted tests and snapshot rewrites when changes are supplied", () => {
  const result = checkDiffHygiene({
    diff: "",
    changedFiles: ["tests/old.test.ts", "tests/__snapshots__/card.snap"],
    changes: [
      { path: "tests/old.test.ts", status: "D" },
      { path: "tests/__snapshots__/card.snap", status: "M" },
    ],
  });
  assert.equal(result.clean, false);
  assert.match(result.violations.join("\n"), /deleted-test/);
  assert.match(result.violations.join("\n"), /snapshot-rewrite/);
});

// --- Stage 3: revert-test proof (fake exec) ----------------------------------

/**
 * Scripted exec: mktemp returns a fixed backup dir, the test command's exit
 * codes come from a queue (one per invocation), everything else succeeds.
 * Every command is recorded so tests can assert backup/restore ran.
 */
function makeRevertExec(testExits: number[]): { exec: ShadowExec; commands: string[] } {
  const commands: string[] = [];
  let testCalls = 0;
  const exec: ShadowExec = async (cmd): Promise<ShadowExecResult> => {
    const joined = cmd.join(" ");
    commands.push(joined);
    if (joined.includes("mktemp -d")) {
      return { exitCode: 0, stdout: "/tmp/swarm-revert-proof-ABC123\n", stderr: "" };
    }
    if (joined.includes("npm test")) {
      const exitCode = testExits[testCalls] ?? 0;
      testCalls += 1;
      return { exitCode, stdout: `run ${testCalls}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { exec, commands };
}

const PROOF_INPUT: RevertProofInput = {
  repoRoot: "/workspace/repo",
  srcFiles: [{ file: "lib/adder.ts", status: "M" }],
  testFiles: ["lib/adder.test.ts"],
  testCommands: ["npm test"],
};

test("revert proof passes when tests fail after revert and pass with the patch", async () => {
  const { exec, commands } = makeRevertExec([1, 0]);
  const result = await runRevertProof(exec, PROOF_INPUT);
  assert.equal(result.status, "pass");
  assert.match(result.details, /fail on unpatched src and pass with the patch/);
  // Backup, revert, and restore all ran through the VM exec channel.
  assert.ok(commands.some((c) => c.includes("cp --parents") && c.includes("lib/adder.ts")));
  assert.ok(commands.some((c) => c.includes("git checkout HEAD")));
  assert.ok(commands.some((c) => c.includes("cp -a") && c.includes("swarm-revert-proof-ABC123")));
  assert.ok(commands.some((c) => c.includes("rm -rf") && c.includes("swarm-revert-proof-ABC123")));
});

test("revert proof fails when tests still pass after revert (tautological)", async () => {
  const { exec, commands } = makeRevertExec([0, 0]);
  const result = await runRevertProof(exec, PROOF_INPUT);
  assert.equal(result.status, "fail");
  assert.match(result.details, /tests pass without the src patch/);
  // The worktree is still restored even on proof failure.
  assert.ok(commands.some((c) => c.includes("cp -a")));
});

test("revert proof fails when tests fail even with the patch applied", async () => {
  const { exec } = makeRevertExec([1, 1]);
  const result = await runRevertProof(exec, PROOF_INPUT);
  assert.equal(result.status, "fail");
  assert.match(result.details, /tests fail with patch applied/);
});

test("revert proof skips when no test files changed", async () => {
  const { exec } = makeRevertExec([]);
  const result = await runRevertProof(exec, { ...PROOF_INPUT, testFiles: [] });
  assert.equal(result.status, "skipped");
});

test("revert proof fails a test-only diff that rewrites expectations, skips pure additions", async () => {
  const { exec } = makeRevertExec([]);
  const rewritten = await runRevertProof(exec, {
    ...PROOF_INPUT,
    srcFiles: [],
    rewrittenExpectations: new Map([["lib/adder.test.ts", 1]]),
  });
  assert.equal(rewritten.status, "fail");
  assert.match(rewritten.details, /test-only diff rewrites existing expectations/);

  const added = await runRevertProof(exec, {
    ...PROOF_INPUT,
    srcFiles: [],
    rewrittenExpectations: new Map([["lib/adder.test.ts", 0]]),
  });
  assert.equal(added.status, "skipped");
});

test("revert proof restores the worktree even when a test command throws", async () => {
  const commands: string[] = [];
  const exec: ShadowExec = async (cmd): Promise<ShadowExecResult> => {
    const joined = cmd.join(" ");
    commands.push(joined);
    if (joined.includes("mktemp -d")) {
      return { exitCode: 0, stdout: "/tmp/swarm-revert-proof-ABC123\n", stderr: "" };
    }
    if (joined.includes("npm test")) throw new Error("VM exec died");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(() => runRevertProof(exec, PROOF_INPUT), /VM exec died/);
  assert.ok(commands.some((c) => c.includes("cp -a")));
  assert.ok(commands.some((c) => c.includes("rm -rf")));
});
