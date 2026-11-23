import test from "node:test";
import assert from "node:assert/strict";
import { parseSlashCommand, formatTestsPrompt } from "./slash";

test("parseSlashCommand: parses /tests with path", () => {
  const cmd = parseSlashCommand("/tests src/utils/math.ts");
  assert.ok(cmd);
  assert.equal(cmd.kind, "tests");
  assert.equal(cmd.target, "src/utils/math.ts");
  assert.equal(cmd.maxIterations, undefined);
});

test("parseSlashCommand: parses --max option", () => {
  const cmd = parseSlashCommand("/tests pkg/foo --max=5");
  assert.ok(cmd);
  assert.equal(cmd.target, "pkg/foo");
  assert.equal(cmd.maxIterations, 5);
});

test("parseSlashCommand: returns null for non-slash or other commands", () => {
  assert.equal(parseSlashCommand("write tests for foo"), null);
  assert.equal(parseSlashCommand("/help"), null);
  assert.equal(parseSlashCommand("  /deploy now"), null);
});

test("parseSlashCommand: handles empty target", () => {
  const cmd = parseSlashCommand("/tests");
  assert.ok(cmd);
  assert.equal(cmd.target, "");
});

test("formatTestsPrompt: includes target and iteration limit and coverage.report instruction", () => {
  const p = formatTestsPrompt("lib/foo.ts", 4);
  assert.match(p, /lib\/foo\.ts/);
  assert.match(p, /4 attempts/);
  assert.match(p, /coverage\.report/);
  assert.match(p, /Never weaken assertions/);
});

test("parseSlashCommand: supports space-separated --max N", () => {
  const cmd = parseSlashCommand("/tests pkg/foo --max 7");
  assert.ok(cmd);
  assert.equal(cmd.target, "pkg/foo");
  assert.equal(cmd.maxIterations, 7);
});

test("parseSlashCommand: quoted paths with spaces", () => {
  const cmd = parseSlashCommand('/tests "src/my feature/math.ts" --max=2');
  assert.ok(cmd);
  assert.equal(cmd.target, "src/my feature/math.ts");
  assert.equal(cmd.maxIterations, 2);
});

test("parseSlashCommand: ignores unknown flags instead of appending them to target", () => {
  const cmd = parseSlashCommand("/tests lib/foo.ts --verbose --dry-run");
  assert.ok(cmd);
  assert.equal(cmd.target, "lib/foo.ts");
});

test("formatTestsPrompt: empty target avoids empty backticks", () => {
  const p = formatTestsPrompt("", 3);
  assert.equal(p.includes("``"), false);
  assert.match(p, /selected target/);
});

test("formatTestsPrompt: strips backticks and newlines from target", () => {
  const p = formatTestsPrompt("lib/`evil`.ts\ninject more", 3);
  const first = p.split("\n")[0];
  assert.equal(first.includes("\n"), false);
  assert.match(first, /lib\/ evil \.ts inject more/);
  assert.equal((first.match(/`/g) ?? []).length, 2); // one opening, one closing
});


test("formatTestsPrompt: caps an over-long target instead of interpolating it whole", () => {
  const long = "x".repeat(2000);
  const p = formatTestsPrompt(long);
  assert.ok(!p.includes(long), "the full over-long target must not appear in the prompt");
  assert.ok(p.includes(`${"x".repeat(500)}…`), "the target is truncated to the cap with an ellipsis");
});

test("formatTestsPrompt: leaves a target at the cap untouched", () => {
  const atCap = "y".repeat(500);
  const p = formatTestsPrompt(atCap);
  assert.ok(p.includes(`\`${atCap}\``), "a 500-char target is interpolated whole");
  assert.ok(!p.includes("…"), "no ellipsis is added at the cap");
});
