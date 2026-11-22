import test from "node:test";
import assert from "node:assert/strict";
import { parseCoverageOutput, formatCoverageSummary } from "./coverage";

test("parseCoverageOutput: istanbul/c8 json-summary", () => {
  const json = JSON.stringify({
    total: { lines: { total: 100, covered: 85, pct: 85 } },
    "src/a.ts": { lines: { total: 50, covered: 45, pct: 90 } },
    "src/b.ts": { lines: { total: 50, covered: 40, pct: 80 } },
  });
  const r = parseCoverageOutput({ files: { "coverage/coverage-summary.json": json } });
  assert.ok(r);
  assert.equal(r.framework, "istanbul/c8");
  assert.equal(Math.round(r.linesPct ?? 0), 85);
  assert.equal(r.files.length, 2);
  assert.match(formatCoverageSummary(r), /85\.0%/);
});

test("parseCoverageOutput: pytest-cov text table", () => {
  const out = `
---------- coverage: platform linux, python 3.11 ----------
Name                      Stmts   Miss  Cover   Missing
-------------------------------------------------------
pkg/a.py                     10      2    80%   5-6
pkg/b.py                      8      0   100%
-------------------------------------------------------
TOTAL                        18      2    89%
`;
  const r = parseCoverageOutput({ stdout: out });
  assert.ok(r);
  assert.equal(r.framework, "pytest-cov");
  assert.equal(r.linesPct, 89);
  assert.equal(r.files.length, 2);
  assert.ok(r.uncoveredRanges.some((x) => x.includes("pkg/a.py:5-6")));
});

test("parseCoverageOutput: go coverprofile", () => {
  const out = `mode: atomic
pkg/a.go:10.2,12.3 2 1
pkg/a.go:14.2,16.3 2 0
pkg/b.go:5.1,5.20 1 1
`;
  const r = parseCoverageOutput({ stdout: out });
  assert.ok(r);
  assert.equal(r.framework, "go-cover");
  assert.ok((r.linesPct ?? 0) > 0 && (r.linesPct ?? 0) < 100);
  assert.equal(r.files.length, 2);
  assert.ok(r.uncoveredRanges.some((x) => x.includes("14-16") || x.includes("pkg/a.go")));
});

test("parseCoverageOutput: generic text fallback", () => {
  const out = "All files      |   76.54 |   70.12 |";
  const r = parseCoverageOutput({ stdout: out });
  assert.ok(r);
  assert.equal(Math.round((r.linesPct ?? 0) * 100) / 100, 76.54);
});

test("parseCoverageOutput: inline istanbul JSON in noisy logs", () => {
  const summary = JSON.stringify({
    total: { lines: { total: 200, covered: 170, pct: 85 } },
    "src/a.ts": { lines: { total: 100, covered: 90, pct: 90 } },
    "src/b.ts": { lines: { total: 100, covered: 80, pct: 80 } },
  });
  const out = [
    "RUNNING TESTS ...",
    'some log line with { braces } and "total" and "lines" words',
    'another { "not": "a summary", "total": 42 } object',
    summary,
    "more noise after { }",
    "DONE",
  ].join("\n");
  const r = parseCoverageOutput({ stdout: out });
  assert.ok(r);
  assert.equal(r.framework, "istanbul/c8");
  assert.equal(r.linesPct, 85);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].path, "src/a.ts");
});

test("parseCoverageOutput: inline JSON does not span across unrelated objects", () => {
  // The old regex matched from the first "{" to the last "}", swallowing
  // everything between two unrelated objects; the extractor must take the
  // balanced object that actually is a summary.
  const out = [
    'config = { "mode": "test", "total": 3 }',
    JSON.stringify({
      total: { lines: { total: 10, covered: 9, pct: 90 } },
      "src/a.ts": { lines: { total: 10, covered: 9, pct: 90 } },
    }),
    'trailer = { "done": true }',
  ].join("\n");
  const r = parseCoverageOutput({ stdout: out });
  assert.ok(r);
  assert.equal(r.framework, "istanbul/c8");
  assert.equal(r.linesPct, 90);
  assert.equal(r.files.length, 1);
});

test("parseCoverageOutput: a huge log without JSON returns null instead of hanging", () => {
  // The old /\{[\s\S]*"total".../ regex backtracked catastrophically on
  // input like this (many "{" with "total"/"lines" but no closing match);
  // the bounded extractor must return promptly.
  const chunk = '{"total": {"lines": ';
  const out = chunk.repeat(20000); // ~400KB of unbalanced braces
  const start = Date.now();
  const r = parseCoverageOutput({ stdout: out });
  const elapsed = Date.now() - start;
  assert.equal(r, null);
  assert.ok(elapsed < 5000, `extraction took ${elapsed}ms`);
});

test("parseCoverageOutput: non-summary JSON values return null", () => {
  for (const bad of ["null", "[]", "{}", '{"total": 42}', '{"total": {"lines": null}}']) {
    assert.equal(
      parseCoverageOutput({ files: { "coverage/coverage-summary.json": bad } }),
      null,
      `${bad} must not produce a report`,
    );
  }
});

test("parseCoverageOutput: pytest-cov --cov-branch table with fractional cover", () => {
  const out = `
---------- coverage: platform linux, python 3.11 ----------
Name                      Stmts   Miss  Branch BrPart  Cover   Missing
-----------------------------------------------------------------------
mypkg/mod.py                 10      2       4      1    80%   5-6
mypkg/other.py                8      0       2      0   100%
-----------------------------------------------------------------------
TOTAL                        18      2       6      1    89.5%
`;
  const r = parseCoverageOutput({ stdout: out });
  assert.ok(r);
  assert.equal(r.framework, "pytest-cov");
  assert.equal(r.linesPct, 89.5);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].path, "mypkg/mod.py");
  assert.equal(r.files[0].linesPct, 80);
  assert.equal(r.files[1].linesPct, 100);
  assert.ok(r.uncoveredRanges.some((x) => x.includes("mypkg/mod.py:5-6")));
});

test("parseCoverageOutput: pytest-cov fractional cover without branch columns", () => {
  const out = `
Name                      Stmts   Miss  Cover   Missing
-------------------------------------------------------
pkg/a.py                     10      2    80%   5-6
-------------------------------------------------------
TOTAL                        10      2    89.5%
`;
  const r = parseCoverageOutput({ stdout: out });
  assert.ok(r);
  assert.equal(r.framework, "pytest-cov");
  assert.equal(r.linesPct, 89.5);
  assert.equal(r.files.length, 1);
});

test("parseCoverageOutput: go coverprofile weights by numStmt, not line span", () => {
  // Two blocks share line 11: line-span weighting counts it twice
  // (total 4, covered 3 -> 75%); statement weighting counts the 15
  // statements (total 15, covered 10 -> 66.7%).
  const out = `mode: count
pkg/x.go:10.1,12.5 10 1
pkg/x.go:11.1,11.9 5 0
`;
  const r = parseCoverageOutput({ stdout: out });
  assert.ok(r);
  assert.equal(r.framework, "go-cover");
  assert.ok(Math.abs((r.linesPct ?? 0) - (100 * 10) / 15) < 0.01, `expected 66.67%, got ${r.linesPct}`);
  assert.ok(r.uncoveredRanges.some((x) => x.includes("pkg/x.go:11")));
});

test("parseCoverageOutput: go coverprofile long block with one statement counts once", () => {
  // A 100-line block with a single statement must not count as 100 lines:
  // statement weighting gives total 100, covered 1 -> 1%, where the old
  // line-span weighting gave 100/101 -> 99%.
  const out = `mode: count
pkg/y.go:1.1,100.50 1 1
pkg/y.go:5.1,5.10 99 0
`;
  const r = parseCoverageOutput({ stdout: out });
  assert.ok(r);
  assert.equal(r.framework, "go-cover");
  assert.ok(Math.abs((r.linesPct ?? 0) - 1) < 0.01, `expected 1%, got ${r.linesPct}`);
});
