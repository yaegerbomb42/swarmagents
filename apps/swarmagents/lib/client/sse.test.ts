import { test } from "node:test";
import assert from "node:assert/strict";
import { SseParser, parseSse, type SseMessage } from "./sse";

test("parses a single complete frame with id/event/data", () => {
  const messages = parseSse("id: 7\nevent: tool.call\ndata: {\"name\":\"Bash\"}\n\n");
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    id: "7",
    event: "tool.call",
    data: '{"name":"Bash"}',
  });
});

test("parses multiple frames in one chunk", () => {
  const text =
    "event: assistant.text\ndata: hello\n\n" +
    "event: tool.result\ndata: {\"ok\":true}\n\n";
  const messages = parseSse(text);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].event, "assistant.text");
  assert.equal(messages[0].data, "hello");
  assert.equal(messages[1].event, "tool.result");
  assert.equal(messages[1].data, '{"ok":true}');
});

test("defaults to data only when no event/id fields are present", () => {
  const messages = parseSse("data: just data\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data, "just data");
  assert.equal(messages[0].event, undefined);
  assert.equal(messages[0].id, undefined);
});

test("incremental feed: partial frames only dispatch once complete", () => {
  const parser = new SseParser();
  const frame = "event: tool.call\ndata: {\"name\":\"Read\"}\n\n";

  assert.deepEqual(parser.push(frame.slice(0, 12)), []);
  assert.deepEqual(parser.push(frame.slice(12, 34)), []);
  const messages = parser.push(frame.slice(34));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, "tool.call");
  assert.equal(messages[0].data, '{"name":"Read"}');
});

test("incremental feed: a data line split across pushes is reassembled", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: x\ndata: abc"), []);
  const messages = parser.push("def\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, "x");
  assert.equal(messages[0].data, "abcdef");
});

test("incremental feed: trailing un-terminated lines stay buffered for the next push", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: y\ndata: 3"), []);
  const messages = parser.push("\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, "y");
  assert.equal(messages[0].data, "3");
});

test("joins multi-line data fields with newlines", () => {
  const messages = parseSse("data: line one\ndata: line two\ndata: line three\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data, "line one\nline two\nline three");
});

test("accepts empty data line and keeps data as empty string", () => {
  const messages = parseSse("event: ping\ndata:\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, "ping");
  assert.equal(messages[0].data, "");
});

test("ignores comment lines and unknown fields", () => {
  const text = ": keep-alive\nx-whatever: nope\nevent: log\ndata: hi\n\n";
  const messages = parseSse(text);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, "log");
  assert.equal(messages[0].data, "hi");
});

test("handles CRLF line endings", () => {
  const messages = parseSse("event: log\r\ndata: hi\r\n\r\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, "log");
  assert.equal(messages[0].data, "hi");
});

test("captures retry field", () => {
  const messages = parseSse("retry: 5000\ndata: hi\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].retryMs, 5000);
});

test("ignores id fields containing NUL", () => {
  const messages = parseSse("id: a\0b\nevent: log\ndata: hi\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, undefined);
});

test("does not dispatch on blank lines with no pending fields", () => {
  assert.deepEqual(parseSse("\n\n"), []);
  assert.deepEqual(parseSse(": comment\n\n"), []);
});

test("empty and whitespace-only chunks produce nothing", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(""), []);
  assert.deepEqual(parser.push("   "), []);
});
