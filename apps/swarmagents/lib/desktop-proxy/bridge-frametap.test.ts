/**
 * Bridge ↔ FrameTap integration tests.
 *
 * The handshake helper is order-tolerant: it feeds the upstream banner and
 * the browser version without asserting who speaks first, so these tests
 * pass both before and after the RFB server-first handshake fix (the
 * bridge's upstream side becomes server-first there). End state is what
 * matters here: spliced, frames forwarded, tap fed.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DesktopBridge, type DesktopBridgeOptions } from "./bridge";
import { FrameTap } from "./frame-tap";
import { RFB_VERSION, SECURITY_NONE } from "./rfb";
import { OP_BINARY, WsFrameDecoder, encodeClientFrame, encodeFrame } from "./ws";

class FakeSocket extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;
  write(data: Buffer): boolean {
    this.writes.push(Buffer.from(data));
    return true;
  }
  feed(data: Buffer): void {
    this.emit("data", data);
  }
  destroy(): void {
    this.destroyed = true;
  }
  end(): void {
    this.emit("close");
  }
}

class Reader {
  private seen = 0;
  private decoder = new WsFrameDecoder(Number.MAX_SAFE_INTEGER);
  constructor(private readonly sock: FakeSocket) {}
  /** Concatenated binary payloads written since the last call. */
  binary(): Buffer {
    const fresh = this.sock.writes.slice(this.seen);
    this.seen = this.sock.writes.length;
    const payloads = fresh
      .flatMap((w) => this.decoder.push(w))
      .filter((m) => m.opcode === OP_BINARY)
      .map((m) => m.payload);
    return Buffer.concat(payloads);
  }
}

function makeBridge(options: Partial<DesktopBridgeOptions> = {}) {
  const client = new FakeSocket();
  const upstream = new FakeSocket();
  const closes: string[] = [];
  const bridge = new DesktopBridge(client as never, upstream as never, {
    mode: "control",
    password: "secret",
    onActivity: () => {},
    onClose: (reason) => closes.push(reason),
    ...options,
  });
  return {
    bridge,
    client,
    upstream,
    closes,
    toClient: new Reader(client),
    toUpstream: new Reader(upstream),
  };
}

type Harness = ReturnType<typeof makeBridge>;

function serverInit(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24 + 4);
  buf.writeUInt16BE(width, 0);
  buf.writeUInt16BE(height, 2);
  buf[4] = 32; // bits-per-pixel
  buf[5] = 24; // depth
  buf[6] = 0; // big-endian flag
  buf[7] = 1; // true-colour flag
  buf.writeUInt16BE(255, 8);
  buf.writeUInt16BE(255, 10);
  buf.writeUInt16BE(255, 12);
  buf[14] = 16; // red shift
  buf[15] = 8; // green shift
  buf[16] = 0; // blue shift
  buf.writeUInt32BE(4, 20);
  buf.write("fake", 24, "latin1");
  return buf;
}

function handshake(h: Harness, width = 64, height = 64): void {
  // Upstream (container) side. Order-tolerant: the bridge may or may not
  // have already sent its version; either way it consumes banner, types,
  // challenge, result, ServerInit in this order.
  h.upstream.feed(
    encodeFrame(OP_BINARY, Buffer.concat([Buffer.from(RFB_VERSION), Buffer.from([1, 2])])),
  );
  h.upstream.feed(encodeFrame(OP_BINARY, crypto.randomBytes(16)));
  h.upstream.feed(encodeFrame(OP_BINARY, Buffer.from([0, 0, 0, 0])));
  h.upstream.feed(encodeFrame(OP_BINARY, serverInit(width, height)));
  // Browser side.
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from(RFB_VERSION)));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([SECURITY_NONE])));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([1]))); // ClientInit shared
  assert.equal(h.bridge.getStatus().spliced, true);
  assert.deepEqual(h.closes, []);
}

/** One Raw rect update, uniform color, BGRA wire order. */
function rawUpdate(w: number, h: number, b: number, g: number, r: number): Buffer {
  const head = Buffer.alloc(4 + 12);
  head[0] = 0;
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(w, 8);
  head.writeUInt16BE(h, 10);
  head.writeInt32BE(0, 12);
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = b;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = r;
    px[i * 4 + 3] = 255;
  }
  return Buffer.concat([head, px]);
}

test("bridge feeds spliced upstream frames to the tap and forwards them", () => {
  const tap = new FrameTap({ storeOptions: { minIntervalMs: 0 } });
  const h = makeBridge({ frameTap: tap });
  handshake(h);
  assert.equal(h.bridge.getFrameTap(), tap);
  h.toClient.binary(); // drain handshake bytes

  const update = rawUpdate(64, 64, 0, 0, 255); // red in BGRA
  h.upstream.feed(encodeFrame(OP_BINARY, update));

  // The browser still receives the payload verbatim.
  assert.ok(h.toClient.binary().includes(update));

  // The tap composited it and stored a first-frame keyframe.
  const frame = tap.latestFrame()!;
  assert.deepEqual([frame.rgba[0], frame.rgba[1], frame.rgba[2]], [255, 0, 0]);
  assert.equal(tap.keyframes.listMeta().length, 1);
});

test("deferred pre-splice upstream bytes reach the tap", () => {
  const tap = new FrameTap({ storeOptions: { minIntervalMs: 0 } });
  const h = makeBridge({ frameTap: tap });
  // Upstream completes and sends a frame before the browser connects.
  h.upstream.feed(
    encodeFrame(OP_BINARY, Buffer.concat([Buffer.from(RFB_VERSION), Buffer.from([1, 2])])),
  );
  h.upstream.feed(encodeFrame(OP_BINARY, crypto.randomBytes(16)));
  h.upstream.feed(encodeFrame(OP_BINARY, Buffer.from([0, 0, 0, 0])));
  h.upstream.feed(encodeFrame(OP_BINARY, serverInit(64, 64)));
  const update = rawUpdate(64, 64, 0, 255, 0); // green
  h.upstream.feed(encodeFrame(OP_BINARY, update));
  // Browser handshake finishes -> splice -> deferred bytes flush.
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from(RFB_VERSION)));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([SECURITY_NONE])));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([1])));
  assert.equal(h.bridge.getStatus().spliced, true);

  const frame = tap.latestFrame()!;
  assert.deepEqual([frame.rgba[0], frame.rgba[1], frame.rgba[2]], [0, 255, 0]);
  assert.equal(tap.keyframes.listMeta().length, 1);
});

test("no tap configured: getFrameTap is null and the stream is unaffected", () => {
  const h = makeBridge();
  handshake(h);
  assert.equal(h.bridge.getFrameTap(), null);
  h.upstream.feed(encodeFrame(OP_BINARY, rawUpdate(64, 64, 1, 2, 3)));
  assert.equal(h.bridge.getStatus().spliced, true);
  assert.deepEqual(h.closes, []);
});

test("a throwing tap is dropped; the desktop stream continues", () => {
  const throwing = {
    setFramebufferSize: () => undefined,
    feed: () => {
      throw new Error("tap exploded");
    },
    close: () => undefined,
    latestFrame: () => null,
    keyframes: undefined,
  } as unknown as FrameTap;
  const h = makeBridge({ frameTap: throwing });
  handshake(h);
  h.toClient.binary();

  const update = rawUpdate(64, 64, 9, 9, 9);
  h.upstream.feed(encodeFrame(OP_BINARY, update));
  // Payload was forwarded before the tap threw; bridge stays spliced.
  assert.ok(h.toClient.binary().includes(update));
  assert.equal(h.bridge.getStatus().spliced, true);
  assert.deepEqual(h.closes, []);
  // The tap was dropped so later frames skip it entirely.
  assert.equal(h.bridge.getFrameTap(), null);
  h.upstream.feed(encodeFrame(OP_BINARY, update));
  assert.equal(h.bridge.getStatus().spliced, true);
});
