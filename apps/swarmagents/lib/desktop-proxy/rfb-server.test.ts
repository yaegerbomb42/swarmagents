/**
 * RfbServerDecoder tests: frames the upstream RFB server-message stream and
 * extracts complete messages in order, tolerating arbitrary TCP slicing,
 * while refusing (throwing) messages/encodings it cannot size safely.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RfbServerDecoder, RfbServerUnsupportedError } from "./rfb-server";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  encoding: number;
  payload?: Buffer;
}

function rectHeader(r: Rect): Buffer {
  const hdr = Buffer.alloc(12);
  hdr.writeUInt16BE(r.x, 0);
  hdr.writeUInt16BE(r.y, 2);
  hdr.writeUInt16BE(r.w, 4);
  hdr.writeUInt16BE(r.h, 6);
  hdr.writeUInt32BE(r.encoding, 8);
  return hdr;
}

/** Build a FramebufferUpdate (type 0) message. */
function fbu(...rects: Rect[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0, 0]), Buffer.alloc(2)];
  parts[1].writeUInt16BE(rects.length, 0);
  for (const r of rects) {
    parts.push(rectHeader(r));
    if (r.payload && r.payload.length > 0) parts.push(r.payload);
  }
  return Buffer.concat(parts);
}

function rawRect(w: number, h: number): Rect {
  return {
    x: 0,
    y: 0,
    w,
    h,
    encoding: 0,
    payload: Buffer.alloc(w * h * 4, 0xab),
  };
}

function copyRect(w: number, h: number): Rect {
  return { x: 0, y: 0, w, h, encoding: 1, payload: Buffer.alloc(4, 0) };
}

const RAW = 0;
const COPY_RECT = 1;

test("decoder: frames a full RAW framebuffer update in one push", () => {
  const dec = new RfbServerDecoder();
  const frame = fbu(rawRect(2, 3)); // raw payload = 2*3*4 = 24 bytes
  const out = dec.push(frame);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 0);
  assert.ok(out[0].raw.equals(frame), "raw bytes preserved byte-for-byte");
});

test("decoder: multiple rectangles in one FBU are framed as a single message", () => {
  const dec = new RfbServerDecoder();
  const frame = fbu(rawRect(1, 1), copyRect(2, 2), rawRect(3, 3));
  const out = dec.push(frame);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 0);
  assert.ok(out[0].raw.equals(frame));
});

test("decoder: frames split across chunks are reassembled in order", () => {
  const dec = new RfbServerDecoder();
  const a = fbu(rawRect(100, 100));
  const b = fbu(copyRect(10, 10));
  const stream = Buffer.concat([a, b]);
  // Feed 1 byte at a time; nothing should be emitted until a message completes.
  const seen: Buffer[] = [];
  for (let i = 0; i < stream.length; i++) {
    for (const f of dec.push(stream.subarray(i, i + 1))) seen.push(f.raw);
  }
  assert.equal(seen.length, 2);
  assert.ok(seen[0].equals(a));
  assert.ok(seen[1].equals(b));
});

test("decoder: control messages (Bell, ServerCutText, SetColourMap, ServerFence) are framed but never type 0", () => {
  const dec = new RfbServerDecoder();
  const bell = Buffer.from([2]);
  const cutTextHeader = Buffer.alloc(8, 0);
  cutTextHeader.writeUInt8(3, 0);
  cutTextHeader.writeUInt32BE(4, 4); // 4-byte text length
  const cutText = Buffer.concat([cutTextHeader, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
  const colourMap = Buffer.concat([
    Buffer.from([1, 0, 0, 0, 0, 2]), // type 1, padding, 2 colours
    Buffer.alloc(2 * 6, 0x11),
  ]);
  const fence = Buffer.concat([Buffer.from([5, 0, 0, 0, 0, 3]), Buffer.from([1, 2, 3])]);
  const out = dec.push(Buffer.concat([bell, cutText, colourMap, fence]));
  assert.equal(out.length, 4);
  for (const f of out) assert.notEqual(f.type, 0, "no control message is type 0");
  assert.equal(out[0].type, 2); // Bell
  assert.equal(out[1].type, 3); // ServerCutText
  assert.equal(out[2].type, 1); // SetColourMapEntries
  assert.equal(out[3].type, 5); // ServerFence
});

test("decoder: throws on an unsupported framebuffer encoding (stops recording, never mis-frames)", () => {
  const dec = new RfbServerDecoder();
  const bad = fbu({
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    encoding: 0xffffffff, // unknown encoding
  });
  assert.throws(() => dec.push(bad), RfbServerUnsupportedError);
});

test("decoder: throws on an unsupported server message type", () => {
  const dec = new RfbServerDecoder();
  assert.throws(() => dec.push(Buffer.from([0x7f])), RfbServerUnsupportedError);
});

test("decoder: rejects a malformed FBU (missing rect header) as unsupported rather than hanging", () => {
  const dec = new RfbServerDecoder();
  // Header claims 1 rect but there are not 12 bytes of rect header yet.
  const incomplete = Buffer.from([0, 0, 0, 1]);
  assert.deepEqual(dec.push(incomplete), [], "incomplete message waits for more bytes");
});
