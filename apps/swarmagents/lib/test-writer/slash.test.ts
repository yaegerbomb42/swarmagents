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
