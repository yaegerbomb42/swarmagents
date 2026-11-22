import test from "node:test";
import assert from "node:assert/strict";
import { RfbInputFilter, RfbProtocolError } from "./rfb-filter";

/**
 * The filter runs post-handshake (the DesktopBridge terminates the browser-side
 * RFB handshake), so every input is a client->server RFB message.
 */

test("view filter relays framebuffer requests and drops key/pointer/cuttext messages", () => {
  const filter = new RfbInputFilter("view");

  // FramebufferUpdateRequest must pass through…
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // 10 bytes
  const fburOut = filter.push(fbur);
  assert.ok(fburOut.equals(fbur), "FramebufferUpdateRequest relayed");

  // …a KeyEvent (type 4, 8 bytes: down-flag, 2 pad, keysym u32) is dropped…
  const key = Buffer.from([4, 0, 0, 0, 0, 0, 0, 85]); // key up, keysym 'U'
  assert.equal(filter.push(key).length, 0, "KeyEvent dropped");

  // …a PointerEvent (type 5, 6 bytes) is dropped…
  const pointer = Buffer.from([5, 1, 2, 0, 3, 0]);
  assert.equal(filter.push(pointer).length, 0, "PointerEvent dropped");

  // …a ClientCutText (type 6: 8-byte header + payload) is dropped.
  const cut = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc")]);
  assert.equal(filter.push(cut).length, 0, "ClientCutText dropped");

  assert.equal(filter.dropped, 3);
});

test("view filter handles messages split across chunk boundaries", () => {
  const filter = new RfbInputFilter("view");

  const key = Buffer.from([4, 0, 0, 0, 0, 0, 0, 85]); // key up, keysym 'U'
  // Feed byte-by-byte: nothing should be emitted until the message is complete,
  // and the complete message must be dropped.
  for (let i = 0; i < key.length - 1; i++) {
    assert.equal(filter.push(key.subarray(i, i + 1)).length, 0);
  }
  assert.equal(filter.push(key.subarray(key.length - 1)).length, 0);
  assert.equal(filter.dropped, 1, "the full 8-byte KeyEvent was dropped exactly once");

  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const half = fbur.subarray(0, 6);
  const rest = fbur.subarray(6);
  const out1 = filter.push(half);
  assert.equal(out1.length, 0, "partial message held back");
  const out2 = filter.push(rest);
  assert.ok(out2.equals(fbur), "completed message relayed");
});

test("view filter passes SetPixelFormat and SetEncodings", () => {
  const filter = new RfbInputFilter("view");

  const pixelFormat = Buffer.alloc(20);
  pixelFormat[0] = 0;
  assert.ok(filter.push(pixelFormat).equals(pixelFormat));

  const encodings = Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1]); // 2 encodings
  assert.ok(filter.push(encodings).equals(encodings));
});

test("multiple messages in one chunk are each framed", () => {
  const filter = new RfbInputFilter("view");
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const key = Buffer.from([4, 0, 0, 0, 0, 0, 0, 85]); // key up, keysym 'U'
  const out = filter.push(Buffer.concat([fbur, key, fbur]));
  assert.ok(out.equals(Buffer.concat([fbur, fbur])), "key dropped, both FBURs relayed");
  assert.equal(filter.dropped, 1);
});

test("control mode relays everything untouched", () => {
  const filter = new RfbInputFilter("control");
  const blob = Buffer.concat([
    Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([4, 0, 0, 0, 0, 0, 0, 85]), // key up, keysym 'U'
  ]);
  assert.ok(filter.push(blob).equals(blob), "control stream relayed verbatim");
});

test("view filter throws on unknown message types instead of falling back to pass-through", () => {
  const filter = new RfbInputFilter("view");

  const unknown = Buffer.from([99, 0, 0, 0]);
  assert.throws(() => filter.push(unknown), RfbProtocolError);
});

test("view filter throws when [99] is followed by a KeyEvent (no input smuggling)", () => {
  const filter = new RfbInputFilter("view");
  const key = Buffer.from([4, 0, 0, 0, 0, 0, 0, 85]); // key up, keysym 'U'
  assert.throws(
    () => filter.push(Buffer.concat([Buffer.from([99, 0, 0, 0]), key])),
    RfbProtocolError,
  );
});

test("view filter throws on SetEncodings count over 256", () => {
  const filter = new RfbInputFilter("view");
  const header = Buffer.alloc(4);
  header[0] = 2;
  header.writeUInt16BE(257, 2);
  assert.throws(() => filter.push(header), RfbProtocolError);
});

test("view filter throws on QEMU subtype !== 0", () => {
  const filter = new RfbInputFilter("view");
  assert.throws(
    () => filter.push(Buffer.from([255, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    RfbProtocolError,
  );
});

test("view filter throws on SetDesktopSize with more than 16 screens", () => {
  const filter = new RfbInputFilter("view");
  const header = Buffer.from([251, 0, 7, 128, 4, 56, 17, 0]);
  assert.throws(() => filter.push(header), RfbProtocolError);
});

test("view filter keeps enforcing after ClientFence / EnableContinuousUpdates (no pass-through)", () => {
  const filter = new RfbInputFilter("view");
  const fence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 1, 3, 9, 9, 9]);
  const ecu = Buffer.from([150, 1, 0, 0, 0, 0, 6, 64, 3, 132]);
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]); // key down, keysym 'A'
  const out = filter.push(Buffer.concat([fence, ecu, key]));
  assert.ok(out.equals(Buffer.concat([fence, ecu])), "fence and ECU relayed, key dropped");
  assert.equal(filter.dropped, 1);
});

test("view filter drops QEMU extended key, xvp and SetDesktopSize", () => {
  const filter = new RfbInputFilter("view");
  const qemuKey = Buffer.from([255, 0, 0, 1, 0, 0, 0, 65, 0, 0, 0, 30]);
  const xvp = Buffer.from([250, 0, 1, 4]);
  const resize = Buffer.concat([Buffer.from([251, 0, 7, 128, 4, 56, 2, 0]), Buffer.alloc(32)]);
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const out = filter.push(Buffer.concat([qemuKey, xvp, resize, fbur]));
  assert.ok(out.equals(fbur));
  assert.equal(filter.dropped, 3);
});

test("view filter skips a large dropped ClientCutText as it streams, without buffering it", () => {
  const filter = new RfbInputFilter("view");
  const header = Buffer.from([6, 0, 0, 0, 0, 0x10, 0, 0]); // 1 MB of text declared
  assert.equal(filter.push(header).length, 0);
  for (let i = 0; i < 16; i++) assert.equal(filter.push(Buffer.alloc(64 * 1024, 0x41)).length, 0);
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(filter.push(fbur).equals(fbur), "stream resynchronised after the skipped message");
  assert.equal(filter.dropped, 1);
});

test("RfbInputFilter is fail-closed by construction", () => {
  assert.equal(RfbInputFilter.failClosed, true);
});

test("applyPolicy accepts monotonic events and tracks the sequence", () => {
  const filter = new RfbInputFilter("view");
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  filter.applyPolicy({ type: 3, seq: 0, size: 10, payload: fbur });
  assert.equal(filter.lastSeq, 0);
  filter.applyPolicy({ type: 3, seq: 1, size: 10, payload: fbur });
  assert.equal(filter.lastSeq, 1);
});

test("applyPolicy rejects a replayed sequence number", () => {
  const filter = new RfbInputFilter("view");
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  filter.applyPolicy({ type: 3, seq: 0, size: 10, payload: fbur });
  assert.throws(
    () => filter.applyPolicy({ type: 3, seq: 0, size: 10, payload: fbur }),
    RfbProtocolError,
  );
});

test("applyPolicy rejects a sequence gap", () => {
  const filter = new RfbInputFilter("view");
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(
    () => filter.applyPolicy({ type: 3, seq: 1, size: 10, payload: fbur }),
    RfbProtocolError,
  );
});

test("applyPolicy rejects an oversized ClientCutText event", () => {
  const filter = new RfbInputFilter("view");
  const payload = Buffer.alloc(8 + 1_048_577);
  payload[0] = 6;
  assert.throws(
    () => filter.applyPolicy({ type: 6, seq: 0, size: payload.length, payload }),
    RfbProtocolError,
  );
});

test("applyPolicy enforces the per-second rate limit and the window resets", () => {
  let nowMs = 1_000_000;
  const filter = new RfbInputFilter("view", {
    maxEventsPerSecond: 2,
    now: () => nowMs,
  });
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  filter.applyPolicy({ type: 3, seq: 0, size: 10, payload: fbur });
  filter.applyPolicy({ type: 3, seq: 1, size: 10, payload: fbur });
  assert.throws(
    () => filter.applyPolicy({ type: 3, seq: 2, size: 10, payload: fbur }),
    RfbProtocolError,
  );
  nowMs += 1000;
  filter.applyPolicy({ type: 3, seq: 2, size: 10, payload: fbur });
  assert.equal(filter.lastSeq, 2);
});

test("view filter throws on a ClientCutText declaring over 1 MiB", () => {
  const filter = new RfbInputFilter("view");
  const header = Buffer.alloc(8);
  header[0] = 6;
  header.writeUInt32BE(1_048_577, 4);
  assert.throws(() => filter.push(header), RfbProtocolError);
});

test("framed messages get monotonic sequence numbers through push", () => {
  const filter = new RfbInputFilter("view");
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(filter.lastSeq, -1);
  filter.push(fbur);
  assert.equal(filter.lastSeq, 0);
  filter.push(Buffer.concat([fbur, fbur]));
  assert.equal(filter.lastSeq, 2);
});

test("view filter frames a real 8-byte KeyEvent at the right offset (regression)", () => {
  // RFC 6143 §7.5.4: KeyEvent is 8 bytes on the wire (type, down-flag,
  // 2 padding, keysym u32). Framing it as 6 bytes leaves the last 2 keysym
  // bytes to be mis-read as the next message's type.
  const filter = new RfbInputFilter("view");
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 85]); // key down, keysym 'U'
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const out = filter.push(Buffer.concat([key, fbur]));
  assert.ok(out.equals(fbur), "message after the KeyEvent framed at the right offset and relayed");
  assert.equal(filter.dropped, 1, "KeyEvent dropped");
  assert.equal(filter.lastSeq, 1, "both messages framed as events");
});

test("view filter resyncs after an 8-byte KeyEvent split inside the keysym (regression)", () => {
  const filter = new RfbInputFilter("view");
  const key = Buffer.from([4, 1, 0, 0, 0x12, 0x34, 0x56, 0x78]); // key down, keysym 0x12345678
  const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // Split inside the keysym: the partial input message is skipped as it
  // streams, and the following message must still frame correctly.
  assert.equal(filter.push(key.subarray(0, 5)).length, 0);
  const out = filter.push(Buffer.concat([key.subarray(5), fbur]));
  assert.ok(out.equals(fbur), "stream resynchronised after the split KeyEvent");
  assert.equal(filter.dropped, 1, "KeyEvent dropped exactly once");
});

test("applyPolicy accepts an 8-byte KeyEvent event (regression)", () => {
  const filter = new RfbInputFilter("view");
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 85]); // key down, keysym 'U'
  filter.applyPolicy({ type: 4, seq: 0, size: 8, payload: key });
  assert.equal(filter.lastSeq, 0);
});
