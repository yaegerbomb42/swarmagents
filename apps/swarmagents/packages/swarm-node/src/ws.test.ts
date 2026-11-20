/**
 * Tests for the runner's websocket client and its credential store.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeFrames, encodeClientFrame, OP_BINARY, OP_TEXT } from "./ws";
import { clearCredentials, loadCredentials, saveCredentials } from "./credentials";

test("ws: a client frame round-trips through the decoder", () => {
  const payload = Buffer.from("hello node", "utf8");
  const frame = encodeClientFrame(OP_TEXT, payload);
  const decoded = decodeFrames(frame);
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0].opcode, OP_TEXT);
  assert.equal(decoded.frames[0].payload.toString("utf8"), "hello node");
  assert.equal(decoded.rest.length, 0);
});

test("ws: binary frames survive the round trip", () => {
  const payload = Buffer.from([0x00, 0xff, 0x10, 0x42]);
  const decoded = decodeFrames(encodeClientFrame(OP_BINARY, payload));
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0].opcode, OP_BINARY);
  assert.deepEqual([...decoded.frames[0].payload], [...payload]);
});

test("ws: frames split across reads are reassembled", () => {
  const payload = Buffer.from("split", "utf8");
  const frame = encodeClientFrame(OP_TEXT, payload);
  const first = decodeFrames(frame.subarray(0, 3));
  assert.equal(first.frames.length, 0);
  const second = decodeFrames(Buffer.concat([first.rest, frame.subarray(3)]));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].payload.toString("utf8"), "split");
});

test("credentials: the token is stored with owner-only permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-node-creds-"));
  const file = path.join(dir, "credentials.json");
  saveCredentials({ server: "ws://127.0.0.1:1/byoc/ws", token: "secret-token" }, file);

  const loaded = loadCredentials(file);
  assert.ok(loaded);
  assert.equal(loaded.token, "secret-token");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  clearCredentials(file);
  assert.equal(loadCredentials(file), null);
});

test("credentials: a missing or broken file is simply no credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-node-creds-"));
  assert.equal(loadCredentials(path.join(dir, "missing.json")), null);
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "not json");
  assert.equal(loadCredentials(broken), null);
});
