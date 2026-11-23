import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  WsFrameDecoder,
  WsBufferOverflowError,
  closeFrame,
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

test("WsFrameDecoder rejects reserved bits and reserved opcodes", () => {
  // RSV1 set (0x40) on an otherwise valid binary frame.
  assert.throws(() => new WsFrameDecoder().push(Buffer.from([0xc2, 0])), /Reserved bits/);
  // Opcode 0x3 is reserved for future data frames.
  assert.throws(() => new WsFrameDecoder().push(Buffer.from([0x83, 0])), /Reserved opcode/);
  // Opcode 0xb is reserved for future control frames.
  assert.throws(() => new WsFrameDecoder().push(Buffer.from([0x8b, 0])), /Reserved opcode/);
  // The stateless decoder applies the same checks.
  assert.throws(() => decodeFrames(Buffer.from([0xc2, 0])), /Reserved bits/);
});

test("closeFrame truncates an over-long reason to the 125-byte control cap", () => {
  const frame = closeFrame(1000, "x".repeat(500));
  const { messages } = decodeFrames(frame);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.length, 125);
  assert.equal(messages[0].payload.readUInt16BE(0), 1000);
});

test("encodeFrame rejects an opcode outside the low nibble", () => {
  assert.throws(() => encodeFrame(0x1f, Buffer.alloc(0)), /Invalid opcode/);
  assert.throws(() => encodeFrame(-1, Buffer.alloc(0)), /Invalid opcode/);
});
