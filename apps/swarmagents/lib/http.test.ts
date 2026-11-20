/**
 * Tests for the shared bounded JSON body reader (lib/http): the 413 cap,
 * malformed/empty bodies as 400, and byte-length (not character-length)
 * accounting.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_JSON_BODY_BYTES, JsonBodyError, readJsonBody } from "./http";

function request(body: string): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("readJsonBody parses a valid JSON body", async () => {
  const body = await readJsonBody(request(JSON.stringify({ id: "openai", rank: 2 })));
  assert.deepEqual(body, { id: "openai", rank: 2 });
});

test("readJsonBody rejects a malformed body with a 400", async () => {
  await assert.rejects(readJsonBody(request("{not json")), (err: unknown) => {
    assert.ok(err instanceof JsonBodyError);
    assert.equal(err.status, 400);
    assert.equal(err.message, "Invalid JSON body.");
    return true;
  });
});

test("readJsonBody rejects an empty body with a 400", async () => {
  await assert.rejects(readJsonBody(request("")), (err: unknown) => {
    assert.ok(err instanceof JsonBodyError);
    assert.equal(err.status, 400);
    return true;
  });
});

test("readJsonBody rejects an oversized body with a 413", async () => {
  const big = JSON.stringify({ pad: "x".repeat(DEFAULT_MAX_JSON_BODY_BYTES) });
  await assert.rejects(readJsonBody(request(big)), (err: unknown) => {
    assert.ok(err instanceof JsonBodyError);
    assert.equal(err.status, 413);
    assert.equal(err.message, "Request body is too large.");
    return true;
  });
});

test("readJsonBody honours a caller-supplied maxBytes cap", async () => {
  const body = await readJsonBody(request('{"a":1}'), 16);
  assert.deepEqual(body, { a: 1 });
  await assert.rejects(readJsonBody(request('{"a":1}'), 4), (err: unknown) => {
    assert.ok(err instanceof JsonBodyError);
    assert.equal(err.status, 413);
    return true;
  });
});

test("readJsonBody measures bytes, not characters", async () => {
  // "é" is 2 bytes in UTF-8 but 1 char: 4 of them plus the JSON quotes are
  // 10 bytes, so a 9-byte cap must fire while a 10-byte cap must pass.
  const body = JSON.stringify("é".repeat(4));
  await assert.rejects(readJsonBody(request(body), 9), (err: unknown) => {
    assert.ok(err instanceof JsonBodyError);
    assert.equal(err.status, 413);
    return true;
  });
  const ok = await readJsonBody(request(body), 10);
  assert.equal(ok, "é".repeat(4));
});
