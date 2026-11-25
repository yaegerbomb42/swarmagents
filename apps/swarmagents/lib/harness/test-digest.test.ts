import test from "node:test";
import assert from "node:assert/strict";
import { extractTestSummary, relevantLines, testDigest } from "./test-digest";

test("extractTestSummary parses vitest, jest, pytest, tap, mocha, and cargo summaries", () => {
  assert.equal(extractTestSummary("Tests  12 passed | 2 failed | 1 skipped (15)"), "12 passed, 2 failed, 1 skipped");
  assert.equal(extractTestSummary("Tests:       1 failed, 9 passed, 10 total"), "9 passed, 1 failed");
  assert.equal(extractTestSummary("==== 2 failed, 40 passed in 1.23s ===="), "40 passed, 2 failed");
  assert.equal(extractTestSummary("# tests 5\n# pass 4\n# fail 1"), "4 passed, 1 failed");
  assert.equal(extractTestSummary("  10 passing (1s)\n  2 failing"), "10 passed, 2 failed");
  assert.equal(extractTestSummary("test result: FAILED. 8 passed; 1 failed; 0 ignored"), "8 passed, 1 failed");
});

test("testDigest compresses human vitest and pytest failures under 1500 chars and dedupes", () => {
  const vitestOut = [
    " FAIL  src/math.test.ts > adds numbers",
    " ❯ src/math.test.ts:14:9",
    "   AssertionError: expected 4 to deeply equal 5",
    " FAIL  src/math.test.ts > adds numbers",
    " ❯ src/math.test.ts:14:9",
    "   AssertionError: expected 4 to deeply equal 5",
    " Tests  1 failed | 19 passed (20)",
  ].join("\n");
  const digest = testDigest("npx vitest run", vitestOut, "turn-1_tool-2");
  assert.ok(digest);
  assert.ok(digest.length <= 1500);
  assert.match(digest, /tests: 19 passed, 1 failed/);
  assert.match(digest, /repeats 2x/);
  assert.match(digest, /src\/math\.test\.ts:14:9/);

  const pytestOut = [
    "________________ test_login _________________",
    "    def test_login():",
    ">       assert code == 200",
    "E       AssertionError: assert 500 == 200",
    "tests/test_auth.py:22: AssertionError",
    "FAILED tests/test_auth.py::test_login - AssertionError: assert 500 == 200",
    "=== 1 failed, 9 passed in 0.88s ===",
  ].join("\n");
  const pyDigest = testDigest("pytest -q", pytestOut);
  assert.ok(pyDigest);
  assert.match(pyDigest, /tests: 9 passed, 1 failed/);
  assert.match(pyDigest, /tests\/test_auth\.py:22/);
});

test("testDigest ignores compound commands and relevantLines drops node_modules noise", () => {
  assert.equal(testDigest("npm test && echo done", "Tests: 1 failed, 0 passed"), undefined);
  assert.equal(testDigest("echo hi", "Tests: 1 failed, 0 passed"), undefined);
  const kept = relevantLines([
    "AssertionError: boom",
    "    at node_modules/vitest/dist/chunk.js:10:2",
    "    at src/foo.ts:12:3",
  ].join("\n"));
  assert.ok(kept.some((l) => l.includes("AssertionError: boom")));
  assert.ok(kept.some((l) => l.includes("src/foo.ts:12:3")));
  assert.ok(!kept.some((l) => l.includes("node_modules")));
});
