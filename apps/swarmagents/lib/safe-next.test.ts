import test from "node:test";
import assert from "node:assert/strict";
import { safeNextPath } from "./safe-next";

test("safeNextPath accepts same-origin absolute paths", () => {
  for (const path of ["/ok", "/ok?x=1", "/deep/path#frag"]) {
    assert.equal(safeNextPath(path), path);
  }
  assert.equal(safeNextPath("  /trimmed  "), "/trimmed");
});

test("safeNextPath rejects unsafe URLs, control characters, and non-strings", () => {
  const rejected: unknown[] = [
    "//evil.example",
    "https://evil.example",
    "http://evil.example/path",
    "javascript:alert(1)",
    "/\\evil",
    "/ok\r\nSet-Cookie: x=1",
    "/ok\nnext",
    "/ok\u0000tail",
    "/ok\u007f",
    "",
    "   ",
    undefined,
    null,
    42,
    {},
    [],
    true,
  ];
  for (const value of rejected) assert.equal(safeNextPath(value), "/");
});

test("safeNextPath enforces the 2048-character boundary", () => {
  assert.equal(safeNextPath(`/${"a".repeat(2048)}`), "/");
  const longest = `/${"a".repeat(2047)}`;
  assert.equal(safeNextPath(longest), longest);
});
