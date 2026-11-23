/**
 * Tests for the observation filter pipeline
 * (lib/harness/observation-filter.ts).
 *
 * Unit tests pin the pre-filters, detection, each extractor's caps and
 * the spill-to-disk pointer. The fixture benchmark suite at the bottom
 * runs 10 realistic noisy logs through the pipeline and asserts the
 * exit criteria: >= 75% median token reduction while retaining 100% of
 * failing test names, error codes and file:line references.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateTokens } from "../codebase/tokens";
import {
  DEFAULT_MAX_INLINE_CHARS,
  collapseCarriageReturns,
  dedupeConsecutiveLines,
  detectKind,
  extractBuild,
  extractSearch,
  extractTest,
  filterObservation,
  preFilter,
  stripAnsi,
} from "./observation-filter";

// ---------------------------------------------------------------------------
// Pre-filters
// ---------------------------------------------------------------------------

test("pre-filters strip ANSI, collapse spinner frames and dedupe repeats", () => {
  assert.equal(stripAnsi("\x1B[31mred\x1B[0m and \x1B[1mbold\x1B[0m"), "red and bold");
  assert.equal(
    collapseCarriageReturns("downloading 10%\rdownloading 50%\rdownloading 100%\nnext line"),
    "downloading 100%\nnext line",
  );
  assert.equal(
    dedupeConsecutiveLines("a\nb\nb\nb\nc\nc\nd"),
    "a\nb\n[... repeated 2 more times]\nc\n[... repeated 1 more time]\nd",
  );
  assert.equal(preFilter("\x1B[32mok\x1B[0m\r\x1B[32mok\x1B[0m\nok\nok"), "ok\n[... repeated 2 more times]");
  assert.equal(preFilter(""), "");
});

test("detectKind uses the command first, then the output signature", () => {
  assert.equal(detectKind("npm test", ["nothing yet"]), "test");
  assert.equal(detectKind("tsc --noEmit", ["nothing yet"]), "build");
  assert.equal(detectKind("rg foo", ["nothing yet"]), "search");
  assert.equal(detectKind(undefined, ["FAIL src/a.test.ts", "  ● thing"]), "test");
  assert.equal(detectKind(undefined, ["src/a.ts(1,2): error TS2322: nope"]), "build");
  const rg = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts:${i + 1}:match ${i}`);
  assert.equal(detectKind(undefined, rg), "search");
  assert.equal(detectKind(undefined, ["hello", "world"]), "generic");
  assert.equal(detectKind("ls -la", ["total 4", "drwxr-xr-x"]), "search");
});

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

test("test extractor collapses passes to a tally and caps user-code frames at 8", () => {
  const lines: string[] = ["FAIL src/upload/upload.test.ts"];
  for (let i = 0; i < 50; i++) lines.push(`  ✓ test number ${i} works (5 ms)`);
  lines.push("  ● Upload › retries the upload 3 times");
  lines.push("    Expected: 200");
  lines.push("    Received: 500");
  for (let i = 0; i < 12; i++) lines.push(`    at Object.<anonymous> (src/upload/upload.test.ts:${40 + i}:7)`);
  for (let i = 0; i < 10; i++) lines.push(`    at Object.<anonymous> (/repo/node_modules/pkg/index.js:${i}:1)`);
  lines.push("  ✓ test after the failure (3 ms)");
  lines.push("Test Suites: 1 failed, 1 total");
  lines.push("Tests:       1 failed, 51 passed, 52 total");
  lines.push("Time:        3.234 s");
  const extracted = extractTest(lines);
  assert.ok(extracted);
  assert.equal(extracted.tally.passed, 51);
  assert.equal(extracted.tally.failed, 1);
  assert.match(extracted.text, /^PASS: 51\/52 tests \(3\.234s\)/);
  assert.match(extracted.text, /retries the upload 3 times/);
  assert.match(extracted.text, /Expected: 200/);
  assert.match(extracted.text, /Received: 500/);
  const userFrames = extracted.text.split("\n").filter((l) => l.includes("src/upload/upload.test.ts:")).length;
  assert.equal(userFrames, 8, "only the top 8 user-code frames survive");
  assert.match(extracted.text, /10 internal frames omitted/);
  assert.ok(!extracted.text.includes("test number 0"), "passing tests collapse to the tally");
});

test("build extractor caps cascading identical errors at 5 per file", () => {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push("src/upload/retry.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.");
  }
  for (let i = 0; i < 10; i++) {
    lines.push("src/upload/client.ts(7,9): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'.");
  }
  lines.push("src/other.ts(1,1): error TS2304: Cannot find name 'foo'.");
  const extracted = extractBuild(lines);
  assert.ok(extracted);
  const kept = extracted.text.split("\n");
  assert.equal(kept.filter((l) => /^src\/upload\/retry\.ts\(12,3\): error TS2322/.test(l)).length, 5);
  assert.equal(kept.filter((l) => /^src\/upload\/client\.ts\(7,9\): error TS2345/.test(l)).length, 5);
  assert.match(extracted.text, /25 more identical TS2322 errors in src\/upload\/retry\.ts omitted/);
  assert.match(extracted.text, /5 more identical TS2345 errors in src\/upload\/client\.ts omitted/);
  assert.match(extracted.text, /TS2304/);
});

test("search extractor caps at 60 matches with total and directory breakdown", () => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) lines.push(`src/mod${i % 5}/file${i}.ts:${i + 1}:const needle_${i} = true;`);
  for (let i = 0; i < 20; i++) lines.push(`lib/util${i}.ts:${i + 1}:needle_${i}`);
  const extracted = extractSearch(lines);
  const kept = extracted.text.split("\n");
  assert.equal(kept.length, 61, "60 matches + the footer");
  assert.match(extracted.text, /120 total matches; showing first 60/);
  assert.match(extracted.text, /src\/ \(100\)/);
  assert.match(extracted.text, /lib\/ \(20\)/);
  assert.ok(extracted.text.includes("src/mod0/file0.ts:1:"));
  assert.ok(!extracted.text.includes("lib/util19.ts:20:"));
});

// ---------------------------------------------------------------------------
// Spill to disk
// ---------------------------------------------------------------------------

test("filterObservation spills the raw output and returns head + tail + pointer", () => {
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-obs-test-"));
  try {
    // 100 failing tests: every failure header + diff line survives the
    // test extractor, so the filtered output is 200 lines and spills.
    const parts: string[] = [];
    for (let i = 0; i < 100; i++) {
      parts.push(`  ● Suite › test number ${i} fails`);
      parts.push(`    Expected: ${i} Received: ${i + 1} at src/suite.test.ts:${10 + i}:3`);
    }
    const output = parts.join("\n");
    const result = filterObservation({
      command: "npm test",
      output,
      turnId: "turn-7",
      toolId: "tool-3",
      maxInlineChars: 500,
      spillDir,
    });
    assert.equal(result.kind, "test");
    assert.ok(result.spilledTo?.endsWith("turn-7_tool-3.log"));
    assert.equal(fs.readFileSync(result.spilledTo!, "utf-8"), output, "the raw output is spilled verbatim");
    assert.match(result.text, /\[TRUNCATED: 120 lines omitted\. Full raw output saved at .*turn-7_tool-3\.log/);
    assert.equal(result.linesOmitted, 120);
    assert.ok(result.text.startsWith("  ● Suite › test number 0 fails"), "head is kept");
    assert.ok(result.text.includes("test number 99 fails"), "tail is kept");
  } finally {
    fs.rmSync(spillDir, { recursive: true, force: true });
  }
});

test("filterObservation never throws when the spill fails", () => {
  const blocker = path.join(os.tmpdir(), `swarm-obs-blocker-${process.pid}`);
  fs.writeFileSync(blocker, "not a directory");
  try {
    const output = "x".repeat(10_000);
    const result = filterObservation({ output, spillDir: blocker, maxInlineChars: 100 });
    assert.equal(result.spilledTo, undefined);
    assert.match(result.text, /Spill to .* failed/);
  } finally {
    fs.rmSync(blocker, { force: true });
  }
});

test("filterObservation leaves a small log alone", () => {
  const result = filterObservation({ command: "echo hi", output: "hello\nworld\n" });
  assert.equal(result.kind, "generic");
  assert.equal(result.text, "hello\nworld\n");
  assert.equal(result.spilledTo, undefined);
  assert.equal(result.linesOmitted, 0);
});

// ---------------------------------------------------------------------------
// Fixture benchmark suite (exit criteria)
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  command: string;
  output: string;
  /** Strings that must survive verbatim: failing test names, error codes, file:line refs. */
  mustRetain: string[];
}

function jestFailureFixture(): Fixture {
  const lines: string[] = ["FAIL src/upload/upload.test.ts"];
  for (let i = 0; i < 200; i++) lines.push(`  ✓ test number ${i} uploads a file correctly (5 ms)`);
  lines.push("  ● Upload › retries the upload 3 times");
  lines.push("    expect(received).toBe(expected) // Object.is equality");
  lines.push("    Expected: 200");
  lines.push("    Received: 500");
  for (let i = 0; i < 12; i++) lines.push(`    at Object.<anonymous> (src/upload/upload.test.ts:${40 + i}:7)`);
  for (let i = 0; i < 10; i++) lines.push(`    at Object.<anonymous> (/repo/node_modules/pkg/index.js:${i}:1)`);
  lines.push("  ● Upload › times out after 30s");
  lines.push("    thrown: \"Exceeded timeout of 30000 ms for a test.\"");
  lines.push("    at Object.<anonymous> (src/upload/upload.test.ts:88:3)");
  lines.push("Test Suites: 1 failed, 1 total");
  lines.push("Tests:       2 failed, 200 passed, 202 total");
  lines.push("Time:        3.234 s");
  return {
    name: "jest failure with 200 passing tests",
    command: "npx jest src/upload/upload.test.ts",
    output: lines.join("\n"),
    mustRetain: [
      "retries the upload 3 times",
      "times out after 30s",
      "src/upload/upload.test.ts:40:7",
      "src/upload/upload.test.ts:88:3",
      "Expected: 200",
      "Received: 500",
    ],
  };
}

function npmInstallFixture(): Fixture {
  const lines: string[] = [];
  for (let i = 0; i < 800; i++) {
    lines.push(`npm http fetch GET 200 https://registry.npmjs.org/package-${i} 12ms (cache hit)`);
  }
  lines.push("⠋ installing dependencies...\r⠙ installing dependencies...\r⠹ installing dependencies...");
  lines.push("added 1234 packages, and audited 1235 packages in 12s");
  lines.push("npm error code E404");
  lines.push("npm error 404 Not Found - GET https://registry.npmjs.org/definitely-not-a-real-package");
  lines.push("npm error 404");
  lines.push("npm error 404  'definitely-not-a-real-package@*' is not in this registry.");
  return {
    name: "verbose npm install with a 404",
    command: "npm install",
    output: lines.join("\n"),
    mustRetain: ["npm error code E404", "definitely-not-a-real-package", "added 1234 packages"],
  };
}

function tscFixture(): Fixture {
  const lines: string[] = [];
  const errors: [string, string][] = [
    ["src/upload/retry.ts", "TS2322: Type 'string' is not assignable to type 'number'."],
    ["src/upload/client.ts", "TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'."],
    ["src/upload/queue.ts", "TS2304: Cannot find name 'retryBackoff'."],
  ];
  const counts = [30, 25, 25];
  errors.forEach(([file, message], fi) => {
    for (let i = 0; i < counts[fi]; i++) {
      lines.push(`${file}(${10 + i},${3 + (i % 5)}): error ${message}`);
    }
  });
  return {
    name: "tsc with 80 errors",
    command: "npx tsc --noEmit",
    output: lines.join("\n"),
    mustRetain: ["TS2322", "TS2345", "TS2304", "src/upload/retry.ts(10,3)", "src/upload/client.ts(10,3)"],
  };
}

function webpackFixture(): Fixture {
  const lines: string[] = ["asset bundle.abc123.js 1.2 MiB [emitted] [immutable] [big]"];
  for (let i = 0; i < 60; i++) lines.push(`asset chunk-${i}.def456.js 48.${i} KiB [emitted]`);
  for (let i = 0; i < 40; i++) lines.push(`  ./src/module-${i}.ts 12.${i} KiB [built] [code generated]`);
  lines.push("ERROR in ./src/broken.ts 12:3-18");
  lines.push("Module not found: Error: Can't resolve './missing-dep' in '/repo/src'");
  lines.push(" @ ./src/broken.ts 12:3-18");
  lines.push("");
  lines.push("ERROR in ./src/other.ts 44:1-22");
  lines.push("Module parse failed: Unexpected token (44:1)");
  lines.push("You may need an appropriate loader to handle this file type.");
  lines.push("");
  lines.push("webpack 5.90.0 compiled with 2 errors in 1234 ms");
  return {
    name: "webpack bundle output with 2 errors",
    command: "npx webpack --mode production",
    output: lines.join("\n"),
    mustRetain: [
      "ERROR in ./src/broken.ts 12:3-18",
      "ERROR in ./src/other.ts 44:1-22",
      "Can't resolve './missing-dep'",
      "compiled with 2 errors",
    ],
  };
}

function rgFixture(): Fixture {
  const lines: string[] = [];
  const dirs = ["src", "lib", "tests", "app"];
  for (let i = 0; i < 500; i++) {
    const dir = dirs[i % dirs.length];
    lines.push(`${dir}/module-${Math.floor(i / 4)}/file-${i}.ts:${(i % 90) + 1}:const needle_${i} = computeThing(${i});`);
  }
  return {
    name: "giant rg dump (500 matches)",
    command: "rg needle",
    output: lines.join("\n"),
    mustRetain: [
      "500 total matches",
      "src/module-0/file-0.ts:1:const needle_0",
      "src/ (125)",
    ],
  };
}

function pytestFixture(): Fixture {
  const lines: string[] = [];
  for (let i = 0; i < 198; i++) lines.push(`test_upload.py::test_retry_${i} PASSED [ ${String((i % 100) + 1).padStart(2, " ")}%]`);
  lines.push("________________ test_retry_flaky _________________");
  lines.push("    def test_retry_flaky():");
  lines.push(">       assert response.status == 200");
  lines.push("E       AssertionError: assert 500 == 200");
  lines.push("test_upload.py:42: AssertionError");
  lines.push("________________ test_timeout _________________");
  lines.push("    def test_timeout():");
  lines.push(">       await upload_with_timeout()");
  lines.push("E       TimeoutError: timed out after 30s");
  lines.push("test_upload.py:88: TimeoutError");
  lines.push("FAILED test_upload.py::test_retry_flaky - AssertionError: assert 500 == 200");
  lines.push("FAILED test_upload.py::test_timeout - TimeoutError: timed out after 30s");
  lines.push("=== 2 failed, 198 passed in 3.20s ===");
  return {
    name: "pytest failure with 198 passing tests",
    command: "pytest -v",
    output: lines.join("\n"),
    mustRetain: [
      "test_retry_flaky",
      "test_timeout",
      "test_upload.py:42: AssertionError",
      "test_upload.py:88: TimeoutError",
    ],
  };
}

function goTestFixture(): Fixture {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) lines.push(`--- PASS: TestUploadRetry${i} (0.00s)`);
  lines.push("--- FAIL: TestUploadRetryFlaky (0.01s)");
  lines.push("    upload_test.go:42: expected 200, got 500");
  lines.push("    upload_test.go:43: retry count 0, want 3");
  lines.push("FAIL\tgithub.com/swarmagents/upload\t0.123s");
  lines.push("ok  \tgithub.com/swarmagents/other\t0.045s");
  return {
    name: "go test failure with 100 passing tests",
    command: "go test ./...",
    output: lines.join("\n"),
    mustRetain: ["TestUploadRetryFlaky", "upload_test.go:42", "FAIL\tgithub.com/swarmagents/upload"],
  };
}

function cargoFixture(): Fixture {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) lines.push(`test upload::retry_${i} ... ok`);
  lines.push("test upload::timeout ... FAILED");
  lines.push("failures:");
  lines.push("    upload::timeout");
  lines.push("test result: FAILED. 100 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.10s");
  lines.push("error: test failed, to rerun pass `--lib`");
  return {
    name: "cargo test failure with 100 passing tests",
    command: "cargo test",
    output: lines.join("\n"),
    mustRetain: ["upload::timeout", "test result: FAILED. 100 passed; 1 failed"],
  };
}

function eslintFixture(): Fixture {
  const lines: string[] = [];
  const groups: [string, string, string][] = [
    ["src/upload/retry.ts", "@typescript-eslint/no-explicit-any", "Unexpected any. Specify a different type."],
    ["src/upload/client.ts", "no-console", "Unexpected console statement."],
    ["src/upload/queue.ts", "@typescript-eslint/no-unused-vars", "'retryBackoff' is defined but never used."],
  ];
  const counts = [40, 40, 40];
  groups.forEach(([file, rule, message], gi) => {
    for (let i = 0; i < counts[gi]; i++) {
      lines.push(`${file}:${10 + i}:5  error  ${message}  ${rule}`);
    }
  });
  return {
    name: "eslint run with 120 cascading errors",
    command: "npx eslint .",
    output: lines.join("\n"),
    mustRetain: [
      "@typescript-eslint/no-explicit-any",
      "no-console",
      "@typescript-eslint/no-unused-vars",
      "src/upload/retry.ts:10:5",
    ],
  };
}

function genericNoisyFixture(): Fixture {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) lines.push(`\x1B[32m[info]\x1B[0m step ${i} completed in ${i}ms`);
  lines.push("⠋ working...\r⠙ working...\r⠹ working...\r⠸ working...\r✔ done");
  for (let i = 0; i < 100; i++) lines.push("heartbeat ok");
  lines.push("ERROR: disk write failed at src/store/writer.ts:214: ENOSPC no space left on device");
  lines.push("AssertionError: expected queue length 0, got 17 at src/upload/queue.ts:96:11");
  lines.push("FATAL: worker crashed (exit 137) in lib/runtime/manager.ts:1024:3");
  lines.push("error: could not connect to database at lib/db/pool.ts:55:9");
  lines.push("uncaught TypeError: Cannot read properties of undefined at app/server.ts:31:14");
  for (let i = 0; i < 45; i++) lines.push(`misc line ${i} with filler words to pad the log out a little`);
  return {
    name: "generic noisy log (ANSI, spinners, repeats, real errors)",
    command: "bash run-smoke.sh",
    output: lines.join("\n"),
    mustRetain: [
      "src/store/writer.ts:214",
      "src/upload/queue.ts:96:11",
      "lib/runtime/manager.ts:1024:3",
      "lib/db/pool.ts:55:9",
      "app/server.ts:31:14",
    ],
  };
}

const FIXTURES: Fixture[] = [
  jestFailureFixture(),
  npmInstallFixture(),
  tscFixture(),
  webpackFixture(),
  rgFixture(),
  pytestFixture(),
  goTestFixture(),
  cargoFixture(),
  eslintFixture(),
  genericNoisyFixture(),
];

test("fixture benchmark: >= 75% median token reduction, 100% retention of diagnostics", () => {
  const reductions: number[] = [];
  for (const fixture of FIXTURES) {
    const result = filterObservation({ command: fixture.command, output: fixture.output });
    const before = estimateTokens(fixture.output);
    const after = estimateTokens(result.text);
    const reduction = 1 - after / before;
    reductions.push(reduction);
    for (const needle of fixture.mustRetain) {
      assert.ok(
        result.text.includes(needle),
        `${fixture.name}: must retain ${JSON.stringify(needle)}\n--- filtered ---\n${result.text.slice(0, 2000)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `  [obs-filter] ${fixture.name}: ${before} -> ${after} tokens (${Math.round(reduction * 100)}% reduction, kind=${result.kind})`,
    );
  }
  reductions.sort((a, b) => a - b);
  const median = (reductions[4] + reductions[5]) / 2;
  assert.ok(median >= 0.75, `median token reduction ${Math.round(median * 100)}% is below 75% (${reductions.map((r) => Math.round(r * 100)).join(", ")})`);
});
