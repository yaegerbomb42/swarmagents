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
