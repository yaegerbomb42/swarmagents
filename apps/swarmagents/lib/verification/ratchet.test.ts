import test from "node:test";
import assert from "node:assert/strict";
import { checkAntiCheat, failureSignature, judgeGate, runGatesWithFlakyCheck, type GateBaseline, type GateResult } from "./ratchet";

test("judgeGate enforces must-pass vs baseline ratchet semantics", () => {
  const baseline: GateBaseline = {
    unit: { exitCode: 1, failureIds: ["a.test.ts > old"] },
  };
  const sameFail: GateResult = {
    name: "unit",
    level: "ratchet",
    exitCode: 1,
    timedOut: false,
    durationMs: 100,
    structured: true,
    failures: [{ id: "a.test.ts > old", message: "still failing" }],
  };
  assert.equal(judgeGate(sameFail, baseline).pass, true);

  const newFail: GateResult = {
    ...sameFail,
    failures: [...sameFail.failures, { id: "b.test.ts > new", message: "regression" }],
  };
  const verdict = judgeGate(newFail, baseline);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.newFailures, ["b.test.ts > new"]);
  assert.equal(judgeGate({ ...sameFail, timedOut: true }, baseline).pass, false);
  assert.equal(judgeGate({ ...sameFail, level: "must-pass" }, baseline).pass, false);
});

test("failureSignature normalizes line numbers, hex, SHAs, and timings", () => {
  const a = failureSignature(["Error at 0xdeadbeef in a.ts:12:4 (14.2 ms) abcdef1234"]);
  const b = failureSignature(["Error at 0x12345678 in a.ts:99:1 (2.5 ms) 9876543abc"]);
  assert.equal(a, b);
});

test("runGatesWithFlakyCheck quarantines transient failures without failing", async () => {
  let calls = 0;
  const out = await runGatesWithFlakyCheck(
    [{ name: "unit", level: "must-pass", flakyReruns: 1 }],
    async () => {
      calls++;
      if (calls === 1) {
        return {
          name: "unit",
          level: "must-pass",
          exitCode: 1,
          timedOut: false,
          durationMs: 50,
          structured: true,
          failures: [{ id: "flake.test.ts > race", message: "flaked" }],
        };
      }
      return {
        name: "unit",
        level: "must-pass",
        exitCode: 0,
        timedOut: false,
        durationMs: 50,
        structured: true,
        failures: [],
      };
    },
    undefined,
  );
  assert.equal(out.reruns, 1);
  assert.equal(out.results[0]?.exitCode, 0);
  assert.deepEqual(out.flaky, [{ gate: "unit", ids: ["flake.test.ts > race"] }]);
});

test("checkAntiCheat catches deleted tests, count drops, multi-language skips, snapshots, and protected paths", () => {
  const patch = [
    "+++ b/tests/test_auth.py",
    "+@pytest.mark.skip(reason='later')",
    "+++ b/lib/foo.ts",
    "+// @ts-ignore",
    '+const note = "@ts-ignore inside string literal is fine";',
  ].join("\n");
  const violations = checkAntiCheat({
    changes: [
      { path: "tests/old.test.ts", status: "D" },
      { path: "tests/__snapshots__/ui.snap", status: "M" },
      { path: "config/prod.secret", status: "M" },
    ],
    patch,
    protectedPatterns: ["*.secret"],
    baseline: { unit: { exitCode: 0, failureIds: [], tests: { total: 10, passed: 10, failed: 0, skipped: 0 } } },
    results: [
      {
        name: "unit",
        level: "must-pass",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
        structured: true,
        failures: [],
        tests: { total: 8, passed: 8, failed: 0, skipped: 0 },
      },
    ],
  });
  const rules = new Set(violations.map((v) => v.rule));
  assert.equal(rules.has("deleted-test"), true);
  assert.equal(rules.has("test-count-drop"), true);
  assert.equal(rules.has("skip-marker"), true);
  assert.equal(rules.has("snapshot-rewrite"), true);
  assert.equal(rules.has("protected-path"), true);
  assert.equal(
    violations.some((v) => v.detail.includes("string literal")),
    false,
    "string literals must not trigger skip-marker violations",
  );
});
