/**
 * Unit tests for the bounded stream-json line parser
 * (lib/harness/stream-json.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStreamJsonParser } from "./stream-json";

function harness() {
  const lines: unknown[] = [];
  const malformed: string[] = [];
  const parser = createStreamJsonParser({
    onLine: (value) => lines.push(value),
    onMalformed: (line) => malformed.push(line),
  });
  return { parser, lines, malformed };
}

test("splits chunked JSON lines and reports malformed ones", () => {
  const { parser, lines, malformed } = harness();
  parser.push('{"a":1}\n{"b":');
  parser.push('2}\nnot-json\n');
  parser.flush();
  assert.deepEqual(lines, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(malformed, ["not-json"]);
});

test("an overlong unterminated line is reported, truncated, and discarded until newline", () => {
  const lines: unknown[] = [];
  const malformed: string[] = [];
  const parser = createStreamJsonParser(
    { onLine: (value) => lines.push(value), onMalformed: (line) => malformed.push(line) },
    { maxLineBufferChars: 100 },
  );

  parser.push("x".repeat(250));
  assert.equal(malformed.length, 1, "one malformed report for the overlong line");
  assert.match(malformed[0], /line buffer exceeded 100 chars/);
  assert.ok(malformed[0].includes("xxx"), "preview includes line content");
  assert.ok(malformed[0].length < 300, "preview is truncated, not the whole line");

  // More junk without a newline is silently discarded (no extra reports).
  parser.push("y".repeat(250));
  assert.equal(malformed.length, 1);

  // The next newline ends the dropped line; the following valid line parses.
  parser.push('\n{"ok":true}\n');
  assert.deepEqual(lines, [{ ok: true }]);
});

test("flush consumes the trailing line and clears all buffer state", () => {
  const { parser, lines, malformed } = harness();
  parser.push('{"tail":9}'); // no newline
  parser.flush();
  assert.deepEqual(lines, [{ tail: 9 }]);

  // A whitespace-only buffer must not leak into the next line.
  parser.push("   ");
  parser.flush();
  parser.push('{"next":1}\n');
  assert.deepEqual(lines, [{ tail: 9 }, { next: 1 }]);
  assert.deepEqual(malformed, []);
});

test("flush resets discard state after an overlong line", () => {
  const lines: unknown[] = [];
  const malformed: string[] = [];
  const parser = createStreamJsonParser(
    { onLine: (value) => lines.push(value), onMalformed: (line) => malformed.push(line) },
    { maxLineBufferChars: 50 },
  );
  parser.push("z".repeat(200)); // starts discarding
  parser.flush(); // ends and clears the discard state
  parser.push('{"after":true}\n');
  assert.deepEqual(lines, [{ after: true }]);
  assert.equal(malformed.length, 1);
});

test("a very large but well-formed line still parses when it fits under the cap", () => {
  const { parser, lines, malformed } = harness();
  const value = { blob: "q".repeat(20_000) };
  parser.push(JSON.stringify(value) + "\n");
  assert.deepEqual(lines, [value]);
  assert.deepEqual(malformed, []);
});
