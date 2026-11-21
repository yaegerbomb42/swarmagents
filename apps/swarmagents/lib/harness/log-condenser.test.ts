/**
 * Unit tests for the pure log condenser (lib/harness/log-condenser.ts).
 *
 * The acceptance criteria this locks in:
 *   - a noisy log yields failure lines out, capped at 40;
 *   - a small log passes through unchanged;
 *   - empty/garbage input returns a safe fallback and never throws.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { condenseLog, MAX_FAILURE_LINES } from "./log-condenser";

function noiseFrame(index: number): string {
  return `    at node:internal/modules/cjs/loader:${100 + index}:${10 + index} (internal frame)`;
}

function nodeModulesFrame(index: number): string {
  return `    at Object.<anonymous> (/repo/node_modules/pkg/dist/index.js:${index}:1)`;
}

function failureLine(index: number): string {
  return `  AssertionError [ERR_ASSERTION]: expected ${index} to equal ${index + 1}`;
}

test("small logs pass through unchanged", () => {
  const small = "ok line 1\nok line 2\nstatus: all good";
  assert.equal(condenseLog(small), small);
});

test("empty input returns a safe fallback", () => {
  assert.equal(condenseLog(""), "");
  assert.equal(condenseLog("\n"), "");
});

test("noisy log is reduced to failure lines with internal frames stripped", () => {
  const lines: string[] = [];
  for (let i = 0; i < 80; i += 1) {
    lines.push(noiseFrame(i));
    lines.push(nodeModulesFrame(i));
    lines.push(failureLine(i));
    lines.push(`  ✓ passing test ${i}`);
  }
  const out = condenseLog(lines.join("\n"));

  // Every retained line is a failure clue; nothing else survives.
  const kept = out.split("\n");
  assert.ok(kept.length > 0);
  for (const line of kept) {
    assert.match(line, /AssertionError/);
    assert.ok(!/node:internal/.test(line), "internal frames are stripped");
    assert.ok(!/node_modules/.test(line), "node_modules frames are stripped");
    assert.ok(!/passing test/.test(line), "passing lines are dropped");
  }
});

test("failure output is capped at MAX_FAILURE_LINES", () => {
  const lines: string[] = [];
  for (let i = 0; i < 120; i += 1) {
    lines.push(`  error: scenario ${i} failed`);
  }
  assert.equal(lines.length, 120);
  const out = condenseLog(lines.join("\n"));
  assert.equal(out.split("\n").length, MAX_FAILURE_LINES);
});

test("noise wins over a failure clue on the same frame", () => {
  // A node_modules frame that happens to mention "error" is still noise and
  // must not be treated as a failure clue, while real failures survive.
  const noisy = [
    ...Array.from({ length: 50 }, (_, i) => noiseFrame(i)),
    "    at /repo/node_modules/pkg/lib/index.js:3:5 (error in pkg fn)",
    "  error: real failure A",
    "  error: real failure B",
  ].join("\n");
  const out = condenseLog(noisy);
  assert.match(out, /real failure A/);
  assert.match(out, /real failure B/);
  assert.ok(!out.includes("node_modules"), "node_modules frames never survive");
});

test("head/tail fallback when no failure clues are found", () => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    lines.push(`  line ${i} of a quiet log`);
  }
  const out = condenseLog(lines.join("\n"));
  const kept = out.split("\n");
  assert.equal(kept[0], "  line 0 of a quiet log");
  assert.equal(kept[kept.length - 1], "  line 99 of a quiet log");
  assert.ok(kept.includes("...[SNIPPED]..."), "fallback marker is present");
  assert.equal(kept.length, 10 + 1 + 15);
});

test("garbage input returns a deterministic, safe fallback", () => {
  // A single enormous line (no newlines) must not throw and must be bounded.
  const huge = "x".repeat(500_000);
  assert.equal(condenseLog(huge).length, huge.length);

  // A run of blank lines with no content reduces cleanly.
  const blanks = "\n".repeat(500);
  const out = condenseLog(blanks);
  assert.equal(typeof out, "string");
  assert.ok(out.length <= 500);
});
