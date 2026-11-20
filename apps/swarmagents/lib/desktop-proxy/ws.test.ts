import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  WsFrameDecoder,
  WsBufferOverflowError,
  decodeFrames,
  encodeFrame,
  encodeClientFrame,
  OP_BINARY,
  OP_PING,
} from "./ws";

test("WsFrameDecoder reassembles a 200 KB masked frame from 4 KB slices", () => {
  const payload = crypto.randomBytes(200 * 1024);
  const wire = encodeClientFrame(OP_BINARY, payload);
  const d = new WsFrameDecoder();
  const out = [];
  for (let i = 0; i < wire.length; i += 4096) out.push(...d.push(wire.subarray(i, i + 4096)));
  assert.equal(out.length, 1);
  assert.ok(out[0].payload.equals(payload));
  assert.equal(d.bufferedBytes, 0);
});

test("WsFrameDecoder keeps fragment state across calls and allows interleaved control frames", () => {
  const d = new WsFrameDecoder();
  const first = Buffer.from([0x02, 3, 1, 2, 3]); // FIN=0 binary
  const ping = encodeFrame(OP_PING, Buffer.from("x"));
  const last = Buffer.from([0x80, 2, 4, 5]); // FIN=1 continuation
  assert.deepEqual(d.push(first), []);
  const mid = d.push(ping);
  assert.equal(mid.length, 1);
  assert.equal(mid[0].opcode, OP_PING);
  const done = d.push(last);
  assert.equal(done.length, 1);
  assert.equal(done[0].opcode, OP_BINARY);
  assert.deepEqual([...done[0].payload], [1, 2, 3, 4, 5]);
});

test("WsFrameDecoder rejects a stray continuation and an oversize declaration", () => {
  assert.throws(() => new WsFrameDecoder().push(Buffer.from([0x80, 1, 0])), /continuation/);
  const header = Buffer.alloc(10);
  header[0] = 0x82;
  header[1] = 127;
  header.writeUInt32BE(2048, 6);
  assert.throws(() => new WsFrameDecoder(1024).push(header), WsBufferOverflowError);
});

test("decodeFrames (stateless) still returns the incomplete remainder", () => {
  const wire = encodeFrame(OP_BINARY, Buffer.alloc(300, 7));
  const { messages, rest } = decodeFrames(wire.subarray(0, 100));
  assert.equal(messages.length, 0);
  assert.equal(rest.length, 100);
});
