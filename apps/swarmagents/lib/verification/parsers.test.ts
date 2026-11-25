import test from "node:test";
import assert from "node:assert/strict";
import { parseGateOutput, parseJestLike, parseNodeTap, parsePytest, parseTsc, parseCargo, parseGoTest, parseEslint } from "./parsers";

test("parseJestLike extracts failing assertions and strips cwd", () => {
  const report = JSON.stringify({
    numTotalTests: 3,
    numPassedTests: 2,
    numFailedTests: 1,
    testResults: [
      {
        name: "/workspace/repo/src/math.test.ts",
        status: "failed",
        assertionResults: [
          {
            fullName: "math adds",
            status: "failed",
            failureMessages: ["Error: expect(received).toBe(5)\n    at /workspace/repo/src/math.test.ts:10:5"],
            location: { line: 10 },
          },
        ],
      },
    ],
  });
  const parsed = parseJestLike(`> vitest run --reporter=json\n${report}`, {
    gate: "unit",
    exitCode: 1,
    cwd: "/workspace/repo",
  });
  assert.equal(parsed.structured, true);
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0]?.id, "src/math.test.ts > math adds");
  assert.equal(parsed.failures[0]?.location, "src/math.test.ts:10");
  assert.ok(!parsed.failures[0]?.message.includes("/workspace/repo"));
  assert.deepEqual(parsed.tests, { total: 3, passed: 2, failed: 1, skipped: 0 });
});

test("parseNodeTap ignores parent subtest summaries and captures leaf failures", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: suite",
    "    # Subtest: fails here",
    "    not ok 1 - fails here",
    "      ---",
    "      location: '/repo/lib/foo.test.ts:12:3'",
    "      error: 'expected 1 to equal 2'",
    "      ...",
    "not ok 1 - suite",
    "  ---",
    "  failureType: 'subtestsFailed'",
    "  ...",
    "# tests 2",
    "# pass 1",
    "# fail 1",
  ].join("\n");
  const parsed = parseNodeTap(tap, { gate: "node", exitCode: 1, cwd: "/repo" });
  assert.equal(parsed.structured, true);
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0]?.id, "lib/foo.test.ts > suite > fails here");
  assert.equal(parsed.failures[0]?.message, "expected 1 to equal 2");
  assert.deepEqual(parsed.tests, { total: 2, passed: 1, failed: 1, skipped: 0 });
});

test("parseTsc and parseEslint extract file-relative diagnostics", () => {
  const tsc = parseTsc("/repo/src/a.ts(4,9): error TS2322: Type 'string' is not assignable to type 'number'.", {
    gate: "tsc",
    exitCode: 2,
    cwd: "/repo",
  });
  assert.equal(tsc.failures[0]?.id, "src/a.ts:TS2322:Type 'string' is not assignable to type 'number'.");
  assert.equal(tsc.failures[0]?.location, "src/a.ts:4:9");

  const eslint = parseEslint(
    JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          { ruleId: "no-console", severity: 1, message: "warn", line: 1, column: 1 },
          { ruleId: "no-unused-vars", severity: 2, message: "unused x", line: 2, column: 7 },
        ],
      },
    ]),
    { gate: "lint", exitCode: 1, cwd: "/repo" },
  );
  assert.equal(eslint.failures.length, 1);
  assert.equal(eslint.failures[0]?.id, "src/a.ts:no-unused-vars");
});

test("parsePytest, parseGoTest, and parseCargo extract structured test failures", () => {
  const py = parsePytest(
    "FAILED tests/test_app.py::test_auth - assert 401 == 200\n=== 1 failed, 4 passed, 1 skipped in 0.42s ===",
    { gate: "pytest", exitCode: 1, cwd: "/repo" },
  );
  assert.equal(py.failures[0]?.id, "tests/test_app.py::test_auth");
  assert.deepEqual(py.tests, { total: 6, passed: 4, failed: 1, skipped: 1 });

  const go = parseGoTest(
    [
      JSON.stringify({ Action: "run", Package: "pkg/a", Test: "TestAdd" }),
      JSON.stringify({ Action: "output", Package: "pkg/a", Test: "TestAdd", Output: "got 3, want 4" }),
      JSON.stringify({ Action: "fail", Package: "pkg/a", Test: "TestAdd" }),
      JSON.stringify({ Action: "pass", Package: "pkg/a", Test: "TestSub" }),
    ].join("\n"),
    { gate: "go", exitCode: 1, cwd: "/repo" },
  );
  assert.equal(go.failures[0]?.id, "pkg/a.TestAdd");
  assert.deepEqual(go.tests, { total: 2, passed: 1, failed: 1, skipped: 0 });

  const cargo = parseCargo(
    [
      "test ops::div_zero ... FAILED",
      "---- ops::div_zero stdout ----",
      "panicked at assertion failed",
      "failures:",
      "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured",
    ].join("\n"),
    { gate: "cargo", exitCode: 1, cwd: "/repo" },
  );
  assert.equal(cargo.failures[0]?.id, "ops::div_zero");
  assert.match(cargo.failures[0]?.message ?? "", /panicked at assertion failed/);
  assert.equal(parseGateOutput("generic", "boom\n", { gate: "g", exitCode: 1, cwd: "" }).structured, false);
});
