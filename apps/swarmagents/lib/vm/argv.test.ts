import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeShellCommand, shellCommandText } from "./argv";

test("tokenizeShellCommand: splits on whitespace", () => {
  assert.deepEqual(tokenizeShellCommand("ls -la"), ["ls", "-la"]);
  assert.deepEqual(tokenizeShellCommand("  echo   hi  "), ["echo", "hi"]);
});

test("tokenizeShellCommand: single quotes hold literal content", () => {
  assert.deepEqual(tokenizeShellCommand("echo 'hello world'"), ["echo", "hello world"]);
  assert.deepEqual(tokenizeShellCommand("echo 'it''s'"), ["echo", "its"]);
});

test("tokenizeShellCommand: double quotes allow escapes", () => {
  assert.deepEqual(tokenizeShellCommand('echo "a b"'), ["echo", "a b"]);
  assert.deepEqual(tokenizeShellCommand('echo "a\\"b"'), ["echo", 'a"b']);
  assert.deepEqual(tokenizeShellCommand('echo "a\\$b"'), ["echo", "a$b"]);
});

test("tokenizeShellCommand: backslash escapes outside quotes", () => {
  assert.deepEqual(tokenizeShellCommand("echo a\\ b"), ["echo", "a b"]);
  assert.deepEqual(tokenizeShellCommand("echo a\\nb"), ["echo", "anb"]);
});

test("tokenizeShellCommand: unterminated quotes return null", () => {
  assert.equal(tokenizeShellCommand("echo 'oops"), null);
  assert.equal(tokenizeShellCommand('echo "oops'), null);
});

test("tokenizeShellCommand: empty input yields no tokens", () => {
  assert.deepEqual(tokenizeShellCommand(""), []);
  assert.deepEqual(tokenizeShellCommand("   "), []);
});

test("shellCommandText rejoins argv", () => {
  assert.equal(shellCommandText(["echo", "a b"]), "echo a b");
});
