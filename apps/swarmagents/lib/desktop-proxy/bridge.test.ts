/**
 * DesktopBridge framing tests: WebSocket frames split across TCP chunks,
 * fragmented messages, buffer caps, masking toward the container, and the
 * view-only input filter when RFB messages arrive split.
 *
 * The bridge is driven with in-memory sockets so every TCP slicing pattern is
 * deterministic: whatever is "written" by the bridge is captured and decoded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type net from "node:net";
import { DesktopBridge, type DesktopBridgeOptions } from "./bridge";
import { RfbServerDecoder } from "./rfb-server";
import {
  WsFrameDecoder,
  encodeFrame,
  encodeClientFrame,
  OP_BINARY,
  OP_CONTINUATION,
  OP_PING,
  OP_PONG,
  type WsMessage,
} from "./ws";
import { vncDesResponse, RFB_VERSION, SECURITY_NONE } from "./rfb";

const PASSWORD = "s3cret-pw";

class FakeSocket extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;
  ended = false;
  write(data: Buffer | string): boolean {
    this.writes.push(Buffer.from(data));
    return true;
  }
  end(data?: Buffer | string): this {
    if (data) this.write(data);
    this.ended = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  feed(chunk: Buffer): void {
    this.emit("data", chunk);
  }
  feedSliced(data: Buffer, size: number): void {
    for (let i = 0; i < data.length; i += size) this.feed(data.subarray(i, i + size));
  }
}

/** Decodes everything the bridge wrote to one socket, incrementally. */
class Reader {
  private seen = 0;
  private decoder = new WsFrameDecoder(Number.MAX_SAFE_INTEGER);
  constructor(private readonly sock: FakeSocket) {}
  read(): WsMessage[] {
    const fresh = this.sock.writes.slice(this.seen);
    this.seen = this.sock.writes.length;
    return fresh.flatMap((w) => this.decoder.push(w));
  }
  binary(): Buffer {
    return Buffer.concat(this.read().filter((m) => m.opcode === OP_BINARY).map((m) => m.payload));
  }
}

/** Raw frame builder for fragmentation tests (fin/opcode/mask chosen freely). */
function frame(opcode: number, payload: Buffer, opts: { fin?: boolean; masked?: boolean } = {}): Buffer {
  const fin = opts.fin ?? true;
  const key = opts.masked ? crypto.randomBytes(4) : null;
  const len = payload.length;
  let header: Buffer;
  const maskBit = key ? 0x80 : 0;
  const b0 = (fin ? 0x80 : 0) | opcode;
  if (len < 126) header = Buffer.from([b0, maskBit | len]);
  else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = b0;
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = b0;
    header[1] = maskBit | 127;
    header.writeUInt32BE(len, 6);
  }
  if (!key) return Buffer.concat([header, payload]);
  const masked = Buffer.from(payload.map((b, i) => b ^ key[i & 3]));
  return Buffer.concat([header, key, masked]);
}

function serverInit(width = 1600, height = 900, name = "fake-vnc"): Buffer {
  const n = Buffer.from(name);
  // 20-byte fixed part + U32 name length + name (RFC 6143 ServerInit).
  const init = Buffer.alloc(24 + n.length);
  init.writeUInt16BE(width, 0);
  init.writeUInt16BE(height, 2);
  init[4] = 32;
  init[5] = 24;
  init[7] = 1;
  init.writeUInt32BE(n.length, 20);
  n.copy(init, 24);
  return init;
}

interface Harness {
  client: FakeSocket;
  upstream: FakeSocket;
  toClient: Reader;
  toUpstream: Reader;
  closes: string[];
  bridge: DesktopBridge;
}

function makeBridge(mode: "view" | "control", extra: Partial<DesktopBridgeOptions> = {}): Harness {
  const client = new FakeSocket();
  const upstream = new FakeSocket();
  const closes: string[] = [];
  const bridge = new DesktopBridge(client as unknown as net.Socket, upstream as unknown as net.Socket, {
    mode,
    password: PASSWORD,
    onActivity: () => {},
    onClose: (r) => closes.push(r),
    ...extra,
  });
  return { client, upstream, toClient: new Reader(client), toUpstream: new Reader(upstream), closes, bridge };
}

/** Run both RFB handshakes to the spliced state. */
function handshake(h: Harness): void {
  const challenge = crypto.randomBytes(16);
  // RFB is server-first (RFC 6143): toward the container the proxy is the
  // client, so it sends nothing until the container's version arrives.
  assert.equal(h.toUpstream.binary().length, 0, "proxy waits for the upstream version");
  h.upstream.feed(encodeFrame(OP_BINARY, Buffer.concat([Buffer.from(RFB_VERSION), Buffer.from([1, 2])])));
  const upReply = h.toUpstream.binary();
  assert.equal(upReply.subarray(0, 12).toString(), RFB_VERSION, "proxy replies with its version after the banner");
  assert.deepEqual([...upReply.subarray(12)], [2], "VNCAuth selected");
  h.upstream.feed(encodeFrame(OP_BINARY, challenge));
  assert.ok(h.toUpstream.binary().equals(vncDesResponse(PASSWORD, challenge)), "password injected");
  h.upstream.feed(encodeFrame(OP_BINARY, Buffer.from([0, 0, 0, 0])));
  assert.deepEqual([...h.toUpstream.binary()], [1], "ClientInit");
  h.upstream.feed(encodeFrame(OP_BINARY, serverInit()));

  // Toward the browser the proxy is the server: its version string is
  // already on the wire before the browser sends a single byte.
  assert.equal(h.toClient.binary().toString(), RFB_VERSION, "server version sent before the browser speaks");
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from(RFB_VERSION)));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([1])));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([1])));
  const toBrowser = h.toClient.binary();
  // types(2) + result(4) + ServerInit(24 + name); version already consumed.
  assert.deepEqual(
    [...toBrowser.subarray(0, 2)],
    [1, SECURITY_NONE],
    "security types advertised after the version exchange",
  );
  assert.equal(toBrowser.readUInt16BE(6), 1600, "ServerInit carries upstream width");
  assert.equal(toBrowser.readUInt16BE(8), 900, "ServerInit carries upstream height");
  assert.deepEqual(h.closes, []);
}

function bigPayload(size: number): Buffer {
  const b = crypto.randomBytes(size);
  return b;
}

test("bridge: 200 KB upstream frame in 4 KB TCP slices reaches the browser intact", () => {
  const h = makeBridge("view");
  handshake(h);
  const payload = bigPayload(200 * 1024);
  h.upstream.feedSliced(encodeFrame(OP_BINARY, payload), 4096);
  const msgs = h.toClient.read();
  assert.equal(msgs.length, 1, "exactly one message forwarded");
  assert.ok(msgs[0].payload.equals(payload), "payload byte-identical");
  assert.deepEqual(h.closes, []);
});

test("bridge: 200 KB masked browser frame in 4 KB TCP slices reaches the container intact", () => {
  const h = makeBridge("control");
  handshake(h);
  const payload = bigPayload(200 * 1024);
  h.client.feedSliced(encodeClientFrame(OP_BINARY, payload), 4096);
  const msgs = h.toUpstream.read();
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].payload.equals(payload));
  assert.deepEqual(h.closes, []);
});

test("bridge: 1-byte TCP slices in both directions", () => {
  const h = makeBridge("control");
  handshake(h);
  const down = bigPayload(20_000);
  const up = bigPayload(20_000);
  h.upstream.feedSliced(encodeFrame(OP_BINARY, down), 1);
  h.client.feedSliced(encodeClientFrame(OP_BINARY, up), 1);
  assert.ok(h.toClient.binary().equals(down));
  assert.ok(h.toUpstream.binary().equals(up));
});

test("bridge: the whole handshake also survives 1-byte slices", () => {
  const h = makeBridge("view");
  const challenge = crypto.randomBytes(16);
  assert.equal(h.toUpstream.binary().length, 0, "nothing upstream before the banner");
  const feed = (b: Buffer) => h.upstream.feedSliced(encodeFrame(OP_BINARY, b), 1);
  feed(Buffer.concat([Buffer.from(RFB_VERSION), Buffer.from([1, 2])]));
  feed(challenge);
  assert.ok(
    Buffer.concat([Buffer.from(RFB_VERSION), Buffer.from([2]), vncDesResponse(PASSWORD, challenge)]).equals(
      h.toUpstream.binary(),
    ),
    "version reply, security choice, and DES response in order",
  );
  feed(Buffer.from([0, 0, 0, 0]));
  feed(serverInit());
  assert.equal(h.toClient.binary().toString(), RFB_VERSION, "server version sent before the browser speaks");
  for (const b of [Buffer.from(RFB_VERSION), Buffer.from([1]), Buffer.from([1])]) {
    h.client.feedSliced(encodeClientFrame(OP_BINARY, b), 1);
  }
  const toBrowser = h.toClient.binary();
  // types(2) + result(4) + ServerInit; version already consumed above.
  assert.equal(toBrowser.readUInt16BE(6), 1600);
  assert.deepEqual(h.closes, []);
});

test("bridge: ServerInit split across two WebSocket messages still completes the handshake", () => {
  const h = makeBridge("view");
  h.upstream.feed(encodeFrame(OP_BINARY, Buffer.concat([Buffer.from(RFB_VERSION), Buffer.from([1, 1])]))); // None
  h.upstream.feed(encodeFrame(OP_BINARY, Buffer.from([0, 0, 0, 0])));
  const init = serverInit(1280, 720, "split-name");
  h.upstream.feed(encodeFrame(OP_BINARY, init.subarray(0, 26))); // mid name-length
  h.upstream.feed(encodeFrame(OP_BINARY, init.subarray(26, 30))); // mid name
  h.upstream.feed(encodeFrame(OP_BINARY, init.subarray(30)));
  assert.equal(h.toClient.binary().toString(), RFB_VERSION, "server version sent before the browser speaks");
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from(RFB_VERSION)));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([1])));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([1])));
  const toBrowser = h.toClient.binary();
  // types(2) + result(4) + ServerInit; version already consumed above.
  assert.equal(toBrowser.readUInt16BE(6), 1280);
  assert.equal(toBrowser.readUInt16BE(8), 720);
  assert.deepEqual(h.closes, []);
});

test("bridge: RFB handshakes are server-first on both ends (RFC 6143)", () => {
  const h = makeBridge("view");
  // Toward the browser the proxy is the server: its version string is on
  // the wire before the browser sends a single byte. Regression: the proxy
  // used to wait for the browser's version first, but real noVNC waits for
  // the server version — both sides waited and the handshake timed out
  // after 15 s ("Desktop offline").
  assert.equal(h.toClient.binary().toString(), RFB_VERSION, "server version sent immediately");
  // Toward the container the proxy is the client: it must not speak first.
  assert.equal(h.toUpstream.binary().length, 0, "nothing upstream before the banner");
  // The container's banner arrives -> the proxy replies with its version.
  h.upstream.feed(encodeFrame(OP_BINARY, Buffer.from(RFB_VERSION)));
  assert.equal(h.toUpstream.binary().toString(), RFB_VERSION, "client version replies to the banner");
  // The browser replies -> only then are security types advertised.
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from(RFB_VERSION)));
  assert.deepEqual([...h.toClient.binary()], [1, SECURITY_NONE], "security types follow the version exchange");
  assert.deepEqual(h.closes, []);
});

test("bridge: two frames in one TCP chunk are both forwarded, in order", () => {
  const h = makeBridge("control");
  handshake(h);
  const a = bigPayload(300);
  const b = bigPayload(70_000);
  h.upstream.feed(Buffer.concat([encodeFrame(OP_BINARY, a), encodeFrame(OP_BINARY, b)]));
  const down = h.toClient.read();
  assert.equal(down.length, 2);
  assert.ok(down[0].payload.equals(a) && down[1].payload.equals(b));
  h.client.feed(Buffer.concat([encodeClientFrame(OP_BINARY, a), encodeClientFrame(OP_BINARY, b)]));
  const up = h.toUpstream.read();
  assert.equal(up.length, 2);
  assert.ok(up[0].payload.equals(a) && up[1].payload.equals(b));
});

test("bridge: frame boundary in the middle of a header (length and mask key)", () => {
  const h = makeBridge("control");
  handshake(h);
  const payload = bigPayload(100_000); // 64-bit length header
  const down = encodeFrame(OP_BINARY, payload);
  for (const cut of [1, 3, 9]) {
    h.upstream.feed(down.subarray(0, cut));
    h.upstream.feed(down.subarray(cut));
    assert.ok(h.toClient.binary().equals(payload), `upstream header split at ${cut}`);
  }
  const up = encodeClientFrame(OP_BINARY, payload);
  for (const cut of [1, 2, 5, 11, 13]) {
    // 13 = inside the 4-byte mask key after a 10-byte header
    const again = encodeClientFrame(OP_BINARY, payload);
    h.client.feed(again.subarray(0, cut));
    h.client.feed(again.subarray(cut));
    assert.ok(h.toUpstream.binary().equals(payload), `client header split at ${cut}`);
  }
  // A trailing frame starting in the same chunk as the end of the previous one.
  const small = bigPayload(10);
  const joined = Buffer.concat([up, encodeClientFrame(OP_BINARY, small)]);
  h.client.feed(joined.subarray(0, up.length + 1));
  h.client.feed(joined.subarray(up.length + 1));
  assert.ok(h.toUpstream.binary().equals(Buffer.concat([payload, small])));
  assert.deepEqual(h.closes, []);
});

test("bridge: fragmented message (FIN=0 + continuations) split across chunks, with a ping in between", () => {
  const h = makeBridge("control");
  handshake(h);
  const parts = [bigPayload(5000), bigPayload(7000), bigPayload(3000)];
  const stream = Buffer.concat([
    frame(OP_BINARY, parts[0], { fin: false }),
    frame(OP_CONTINUATION, parts[1], { fin: false }),
    frame(OP_PING, Buffer.from("hb")),
    frame(OP_CONTINUATION, parts[2], { fin: true }),
  ]);
  h.upstream.feedSliced(stream, 1000);
  const down = h.toClient.read();
  assert.equal(down.length, 1, "one reassembled message");
  assert.ok(down[0].payload.equals(Buffer.concat(parts)));
  // The upstream ping is answered upstream with a masked pong.
  const pongWrite = h.upstream.writes.at(-1)!;
  assert.ok((pongWrite[1] & 0x80) !== 0, "pong toward the container is masked");
  const pong = h.toUpstream.read();
  assert.equal(pong.length, 1);
  assert.equal(pong[0].opcode, OP_PONG);
  assert.equal(pong[0].payload.toString(), "hb");

  const clientStream = Buffer.concat([
    frame(OP_BINARY, parts[0], { fin: false, masked: true }),
    frame(OP_CONTINUATION, parts[1], { fin: false, masked: true }),
    frame(OP_CONTINUATION, parts[2], { fin: true, masked: true }),
  ]);
  h.client.feedSliced(clientStream, 777);
  assert.ok(h.toUpstream.binary().equals(Buffer.concat(parts)));
  assert.deepEqual(h.closes, []);
});

test("bridge: every frame toward the container is masked (websockify rejects unmasked)", () => {
  const h = makeBridge("control");
  handshake(h);
  h.client.feed(encodeClientFrame(OP_BINARY, bigPayload(70_000)));
  assert.ok(h.upstream.writes.length > 0);
  for (const w of h.upstream.writes) assert.ok((w[1] & 0x80) !== 0, "mask bit set");
  for (const w of h.client.writes) assert.equal(w[1] & 0x80, 0, "browser frames unmasked");
});

test("bridge: frame declaring more than the cap closes the bridge cleanly, without buffering it", () => {
  const h = makeBridge("view");
  handshake(h);
  const header = Buffer.alloc(10);
  header[0] = 0x80 | OP_BINARY;
  header[1] = 127;
  header.writeUInt32BE(33 * 1024 * 1024, 6); // > default 32 MB
  h.upstream.feed(header);
  assert.deepEqual(h.closes, ["upstream-buffer-overflow"]);
  assert.ok(h.client.destroyed && h.upstream.destroyed, "both sockets torn down");
  // Further data is ignored, onClose fires once.
  h.upstream.feed(Buffer.alloc(100));
  assert.equal(h.closes.length, 1);
});

test("bridge: fragments accumulating past the cap close the bridge (client side)", () => {
  const h = makeBridge("control", { maxBufferBytes: 64 * 1024 });
  handshake(h);
  const chunk = bigPayload(20 * 1024);
  h.client.feed(frame(OP_BINARY, chunk, { fin: false, masked: true }));
  h.client.feed(frame(OP_CONTINUATION, chunk, { fin: false, masked: true }));
  h.client.feed(frame(OP_CONTINUATION, chunk, { fin: false, masked: true }));
  assert.deepEqual(h.closes, []);
  h.client.feed(frame(OP_CONTINUATION, chunk, { fin: false, masked: true }));
  assert.deepEqual(h.closes, ["client-buffer-overflow"]);
  assert.ok(h.client.destroyed && h.upstream.destroyed);
});

test("bridge: pre-splice deferred payload is capped too", () => {
  const h = makeBridge("view", { maxBufferBytes: 64 * 1024 });
  // Browser finishes its handshake, upstream never does: further browser data
  // is deferred, and must not grow without bound.
  assert.equal(h.toClient.binary().toString(), RFB_VERSION, "server version sent before the browser speaks");
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from(RFB_VERSION)));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([1])));
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.from([1])));
  for (let i = 0; i < 4 && h.closes.length === 0; i++) {
    h.client.feed(encodeClientFrame(OP_BINARY, bigPayload(30 * 1024)));
  }
  assert.deepEqual(h.closes, ["client-buffer-overflow"]);
});

test("bridge: view-only still drops input when RFB messages are split across frames and chunks", () => {
  const h = makeBridge("view");
  handshake(h);
  const fbur = Buffer.from([3, 1, 0, 0, 0, 0, 6, 64, 3, 132]);
  const key = Buffer.from([4, 1, 0, 0, 0, 0x41, 0, 0]); // KeyEvent (8 bytes, RFC 6143 §7.5.4)
  const pointer = Buffer.from([5, 1, 0, 10, 0, 20]);
  const cut = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 5]), Buffer.from("hello")]);
  const fence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 1, 2, 0xaa, 0xbb]); // ClientFence, 2-byte payload
  const ecu = Buffer.from([150, 1, 0, 0, 0, 0, 6, 64, 3, 132]); // EnableContinuousUpdates
  const qemuKey = Buffer.from([255, 0, 0, 1, 0, 0, 0, 0x41, 0, 0, 0, 30]); // QEMU extended key (12 bytes)
  const resize = Buffer.concat([Buffer.from([251, 0, 7, 128, 4, 56, 1, 0]), Buffer.alloc(16)]);

  // One WS message with everything, delivered in 1-byte TCP slices.
  const all = Buffer.concat([fbur, key, fence, pointer, ecu, cut, qemuKey, resize, fbur]);
  h.client.feedSliced(encodeClientFrame(OP_BINARY, all), 1);
  // RFB messages split across WS message boundaries.
  const tail = Buffer.concat([key, pointer, fbur]);
  for (let i = 0; i < tail.length; i += 4) {
    h.client.feed(encodeClientFrame(OP_BINARY, tail.subarray(i, i + 4)));
  }
  const forwarded = h.toUpstream.binary();
  assert.ok(
    forwarded.equals(Buffer.concat([fbur, fence, ecu, fbur, fbur])),
    "only FBUR / fence / continuous-updates relayed; key, pointer, cut text, QEMU key, resize dropped",
  );
  assert.deepEqual(h.closes, []);
});

test("bridge: bytes arriving with the upgrade (head) go through the decoders", () => {
  const challenge = crypto.randomBytes(16);
  const upHead = Buffer.concat([
    encodeFrame(OP_BINARY, Buffer.concat([Buffer.from(RFB_VERSION), Buffer.from([1, 2])])),
    encodeFrame(OP_BINARY, challenge).subarray(0, 5), // partial frame
  ]);
  const clientHead = encodeClientFrame(OP_BINARY, Buffer.from(RFB_VERSION));
  const h = makeBridge("view", { upstreamHead: upHead, clientHead });
  const up = h.toUpstream.binary();
  assert.equal(up.subarray(0, 12).toString(), RFB_VERSION);
  assert.deepEqual([...up.subarray(12)], [2], "head's security types were processed");
  h.upstream.feed(encodeFrame(OP_BINARY, challenge).subarray(5));
  assert.ok(h.toUpstream.binary().equals(vncDesResponse(PASSWORD, challenge)), "partial head frame completed");
  const toBrowser = h.toClient.binary();
  assert.equal(toBrowser.subarray(0, 12).toString(), RFB_VERSION, "server version written at construction");
  assert.deepEqual(
    [...toBrowser.subarray(12)],
    [1, SECURITY_NONE],
    "client head's version reply answered with security types",
  );
});

test("bridge: browser frame with MASK=0 closes with protocol error 1002", () => {
  const h = makeBridge("view");
  handshake(h);
  // Client->server frames must be masked; an unmasked frame is a protocol error.
  h.client.feed(encodeFrame(OP_BINARY, Buffer.from("hello")));
  assert.deepEqual(h.closes, ["client-mask-violation"]);
  assert.ok(h.client.destroyed && h.upstream.destroyed);
  const closeOut = h.client.writes.at(-1);
  assert.ok(closeOut, "close frame written to browser");
  // 1002 = Protocol Error
  assert.equal(closeOut!.readUInt16BE(2), 1002);
});

test("bridge: upstream frame with MASK=1 closes with protocol error 1002", () => {
  const h = makeBridge("view");
  handshake(h);
  // Server->client frames must not be masked; a masked upstream frame is a protocol error.
  h.upstream.feed(encodeClientFrame(OP_BINARY, Buffer.from("hello")));
  assert.deepEqual(h.closes, ["upstream-mask-violation"]);
  assert.ok(h.client.destroyed && h.upstream.destroyed);
  const closeOut = h.client.writes.at(-1);
  assert.ok(closeOut, "close frame written to browser");
  assert.equal(closeOut!.readUInt16BE(2), 1002);
});

test("bridge: browser backpressure pauses upstream at 8 MB and closes if still over 32 MB after 10 s", async () => {
  const h = makeBridge("control");
  handshake(h);

  let paused = 0;
  let writableLength = 0;
  (h.client as any).write = (data: Buffer | string) => {
    h.client.writes.push(Buffer.from(data));
    writableLength += Buffer.byteLength(data as any);
    return true;
  };
  Object.defineProperty(h.client, "writableLength", { get: () => writableLength, configurable: true });
  (h.upstream as any).pause = () => { paused++; };
  (h.upstream as any).resume = () => {};

  const originalSetTimeout = global.setTimeout;
  let closeTimerFn: (() => void) | null = null;
  (global as any).setTimeout = (fn: any, ms?: number, ...args: any[]) => {
    if (ms === 10_000) {
      closeTimerFn = () => fn(...args);
      return { unref() {} } as any;
    }
    return originalSetTimeout(fn, ms as any, ...args);
  };

  try {
    // Push a large upstream message so the bridge writes to the browser and hits backpressure.
    h.upstream.feed(encodeFrame(OP_BINARY, bigPayload(9 * 1024 * 1024)));
    assert.ok(paused >= 1, "upstream paused when browser queue exceeded 8 MB");
    assert.equal(closeTimerFn, null, "no close timer yet (queue below 32 MB)");

    // Simulate queue growing over 32 MB.
    writableLength = 33 * 1024 * 1024;
    h.upstream.feed(encodeFrame(OP_BINARY, bigPayload(1024)));
    assert.ok(closeTimerFn, "close timer scheduled when browser queue exceeded 32 MB");

    // Still over 32 MB after timeout: bridge closes cleanly.
    (closeTimerFn as () => void)();
    assert.deepEqual(h.closes, ["client-backpressure-timeout"]);
    assert.ok(h.client.destroyed && h.upstream.destroyed);
  } finally {
    (global as any).setTimeout = originalSetTimeout;
  }
});

test("bridge: setMode demotes a live control session to view and restores control", () => {
  const h = makeBridge("control");
  handshake(h);
  const key = Buffer.from([4, 1, 0, 0, 0, 0x41, 0, 0]); // KeyEvent (8 bytes, RFC 6143 §7.5.4)
  const fbur = Buffer.from([3, 1, 0, 0, 0, 0, 6, 64, 3, 132]);

  // Control: input forwarded.
  h.client.feed(encodeClientFrame(OP_BINARY, key));
  assert.ok(h.toUpstream.binary().equals(key), "key forwarded in control mode");

  // Demote to view: input dropped, framebuffer requests still relayed.
  h.bridge.setMode("view");
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.concat([key, fbur])));
  assert.ok(h.toUpstream.binary().equals(fbur), "key dropped after demote, FBUR relayed");

  // Restore control: input forwarded again.
  h.bridge.setMode("control");
  h.client.feed(encodeClientFrame(OP_BINARY, key));
  assert.ok(h.toUpstream.binary().equals(key), "key forwarded again after restore");
  assert.deepEqual(h.closes, []);
});

test("bridge: setMode view->view is a no-op and view->control unblocks input", () => {
  const h = makeBridge("view");
  handshake(h);
  const key = Buffer.from([4, 1, 0, 0, 0, 0x41, 0, 0]); // KeyEvent (8 bytes, RFC 6143 §7.5.4)
  const fbur = Buffer.from([3, 1, 0, 0, 0, 0, 6, 64, 3, 132]);

  h.client.feed(encodeClientFrame(OP_BINARY, key));
  assert.equal(h.toUpstream.binary().length, 0, "key dropped in view mode");

  h.bridge.setMode("view"); // no-op: filter already installed
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.concat([key, fbur])));
  assert.ok(h.toUpstream.binary().equals(fbur), "still view-only after redundant setMode(view)");

  h.bridge.setMode("control");
  h.client.feed(encodeClientFrame(OP_BINARY, key));
  assert.ok(h.toUpstream.binary().equals(key), "key forwarded after promote to control");
  assert.deepEqual(h.closes, []);
});

test("bridge: a view client sending an unknown RFB type terminates the bridge with 1002", () => {
  const h = makeBridge("view");
  handshake(h);
  const key = Buffer.from([4, 1, 0, 0, 0, 0x41, 0, 0]); // KeyEvent (8 bytes, RFC 6143 §7.5.4)
  // [99] (unknown) followed by a KeyEvent must not smuggle input through.
  h.client.feed(encodeClientFrame(OP_BINARY, Buffer.concat([Buffer.from([99, 0, 0, 0]), key])));
  assert.deepEqual(h.closes, ["rfb-view-violation"]);
  assert.ok(h.client.destroyed && h.upstream.destroyed, "both sockets torn down");
  assert.equal(h.toUpstream.binary().length, 0, "no input reached the container");
  const closeOut = h.client.writes.at(-1);
  assert.ok(closeOut, "close frame written to browser");
  assert.equal(closeOut!.readUInt16BE(2), 1002);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the bridge has closed with `reason`, failing if `timeoutMs`
 * elapses first. This is retry-tolerant: a loaded box may delay timers, but
 * the property being asserted (the bridge must eventually close with the given
 * reason) is unchanged.
 */
async function waitUntilClosed(h: Harness, reason: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (h.closes.includes(reason)) return;
    await sleep(10);
  }
  throw new Error(`expected bridge to close with "${reason}"; closes=${JSON.stringify(h.closes)}`);
}

test("bridge: missed keepalive pong fails the bridge (ping-timeout)", async () => {
  const h = makeBridge("view", { pingIntervalMs: 20 });
  handshake(h);
  // No pong is ever answered: the watchdog must fire within a generous budget,
  // regardless of scheduler delays on a loaded box.
  await waitUntilClosed(h, "ping-timeout", 3000);
  assert.ok(h.client.destroyed && h.upstream.destroyed);
});

test("bridge: a pong resets the keepalive watchdog", async () => {
  const h = makeBridge("view", { pingIntervalMs: 40 });
  handshake(h);

  const respondWithPong = () => h.client.feed(encodeClientFrame(OP_PONG, Buffer.alloc(0)));

  // Answer every ping with a pong across several ticks: the watchdog must stay
  // quiet (no ping-timeout) the entire time. Event-driven, so a slow machine
  // cannot skew a fixed-sleep schedule into a false failure.
  let answered = 0;
  const answeringDeadline = Date.now() + 2500;
  while (Date.now() < answeringDeadline) {
    const msgs = h.toClient.read();
    const pings = msgs.filter((m) => m.opcode === OP_PING).length;
    if (pings > 0) {
      for (let i = 0; i < pings; i += 1) respondWithPong();
      answered += pings;
      if (answered >= 4) break;
    }
    assert.equal(h.closes.length, 0, "watchdog must not fire while pongs are answered");
    await sleep(5);
  }
  assert.ok(answered >= 4, `expected to answer >=4 pings, got ${answered}`);

  // Stop answering: the next missed pong must fail the bridge.
  await waitUntilClosed(h, "ping-timeout", 3000);
});

test("bridge: socket end closes the bridge and clears the ping timer", async () => {
  const h = makeBridge("view", { pingIntervalMs: 20 });
  handshake(h);
  assert.equal((h.bridge as any).pingTimer !== null, true);
  h.client.emit("end");
  await waitUntilClosed(h, "client-end", 1000);
  assert.equal((h.bridge as any).pingTimer, null);
  assert.equal(h.client.listenerCount("end"), 0);
  assert.equal(h.client.listenerCount("data"), 0);
  assert.equal(h.upstream.listenerCount("close"), 0);
});

test("bridge: socket close cleans up timers and listeners", async () => {
  const h = makeBridge("control", { pingIntervalMs: 20 });
  handshake(h);
  h.upstream.emit("close");
  await waitUntilClosed(h, "upstream-close", 1000);
  assert.equal((h.bridge as any).pingTimer, null);
  assert.equal((h.bridge as any).timeout, null);
  assert.equal(h.upstream.listenerCount("end"), 0);
  assert.equal(h.upstream.listenerCount("error"), 0);
});

test("bridge: browser backpressure resumes upstream on drain below 8 MB", () => {
  const h = makeBridge("control");
  handshake(h);

  let paused = 0;
  let resumed = 0;
  let writableLength = 0;
  (h.client as any).write = (data: Buffer | string) => {
    h.client.writes.push(Buffer.from(data));
    writableLength += Buffer.byteLength(data as any);
    return true;
  };
  Object.defineProperty(h.client, "writableLength", { get: () => writableLength, configurable: true });
  (h.upstream as any).pause = () => { paused++; };
  (h.upstream as any).resume = () => { resumed++; };

  h.upstream.feed(encodeFrame(OP_BINARY, bigPayload(9 * 1024 * 1024)));
  assert.ok(paused >= 1, "upstream paused");
  writableLength = 1024;
  h.client.emit("drain");
  assert.ok(resumed >= 1, "upstream resumed after drain");
  assert.deepEqual(h.closes, []);
});

test("bridge: getStatus reports live mode, connected, and spliced state", () => {
  const h = makeBridge("view");
  assert.deepEqual(
    h.bridge.getStatus(),
    { mode: "view", connected: true, spliced: false },
    "before the handshake: view, connected, not spliced",
  );
  handshake(h);
  assert.deepEqual(
    h.bridge.getStatus(),
    { mode: "view", connected: true, spliced: true },
    "after the handshake: spliced",
  );
  // setMode is reflected live: the status reads the installed filter.
  h.bridge.setMode("control");
  assert.equal(h.bridge.getStatus().mode, "control");
  h.bridge.setMode("view");
  assert.equal(h.bridge.getStatus().mode, "view");
  // A view violation tears the bridge down: connected flips to false.
  h.client.feed(
    encodeClientFrame(OP_BINARY, Buffer.concat([Buffer.from([99, 0, 0, 0]), Buffer.from([4, 0, 0, 0, 85, 0])])),
  );
  assert.deepEqual(h.closes, ["rfb-view-violation"]);
  assert.equal(h.bridge.getStatus().connected, false);
});

/**
 * Soak: a realistic framebuffer session, not just the unit-sized repro.
 *
 * Frame sizes vary from a 15-byte cursor update to a 250 KB full frame,
 * upstream pings are interleaved (including between fragments of one message),
 * the browser answers keepalives, and a view->control promotion happens
 * mid-stream. Crucially, every frame is delivered in irregular TCP slices that
 * do NOT line up with WebSocket frame boundaries: a decoder that reassembled
 * only what arrived in a single chunk would drop most of this stream, so this
 * test fails if the streaming WsFrameDecoder is ever reverted.
 */
test("bridge: soak — a realistic framebuffer stream holds across mixed frames, pings and a view→control switch", () => {
  const h = makeBridge("view");
  handshake(h);

  const key = Buffer.from([4, 1, 0, 0, 0, 0x41, 0, 0]); // KeyEvent (8 bytes, RFC 6143 §7.5.4)
  const fbur = Buffer.from([3, 1, 0, 0, 0, 0, 6, 64, 3, 132]);

  // A view-only client cannot inject input, but framebuffer requests pass.
  h.client.feedSliced(encodeClientFrame(OP_BINARY, key), 13);
  assert.equal(h.toUpstream.binary().length, 0, "view mode drops key events");
  h.client.feedSliced(encodeClientFrame(OP_BINARY, fbur), 13);
  assert.ok(h.toUpstream.binary().equals(fbur), "view mode relays framebuffer requests");

  // Deterministic pseudo-random TCP slicing: a frame never gets to assume it
  // arrives in one piece.
  let seed = 0x2f6e2b1;
  const sliceSizes = [137, 900, 1500, 4096, 37, 2048, 8192, 211, 777];
  let feeds = 0;
  const feedStream = (data: Buffer): void => {
    let off = 0;
    while (off < data.length) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const size = Math.min(sliceSizes[seed % sliceSizes.length], data.length - off);
      h.upstream.feed(data.subarray(off, off + size));
      off += size;
      feeds++;
    }
  };

  const frameSizes = [72, 5120, 200 * 1024, 15, 48 * 1024, 90_000, 300, 250 * 1024, 640, 8 * 1024];
  const expected: Buffer[] = [];

  for (let cycle = 0; cycle < 2; cycle++) {
    for (let i = 0; i < frameSizes.length; i++) {
      const index = cycle * frameSizes.length + i;
      const payload = bigPayload(frameSizes[i]);
      expected.push(payload);

      if (index % 3 === 2) {
        // Fragmented update with a keepalive ping between the two fragments.
        const cut = Math.floor(payload.length / 2);
        const label = `hb-${index}`;
        feedStream(Buffer.concat([
          frame(OP_BINARY, payload.subarray(0, cut), { fin: false }),
          frame(OP_PING, Buffer.from(label)),
          frame(OP_CONTINUATION, payload.subarray(cut), { fin: true }),
        ]));
        const pongs = h.toUpstream.read().filter((m) => m.opcode === OP_PONG);
        assert.equal(pongs.length, 1, `ping ${label} answered`);
        assert.equal(pongs[0].payload.toString(), label, "pong echoes the ping payload");
        assert.ok((h.upstream.writes.at(-1)![1] & 0x80) !== 0, "pong toward the container is masked");
      } else {
        feedStream(encodeFrame(OP_BINARY, payload));
      }

      // The browser acknowledges the bridge's own keepalive pings.
      if (index % 4 === 0) h.client.feed(encodeClientFrame(OP_PONG, Buffer.alloc(0)));

      // Promote mid-stream: the very same socket now allows input.
      if (index === 7) {
        h.bridge.setMode("control");
        h.client.feedSliced(encodeClientFrame(OP_BINARY, key), 7);
        assert.ok(h.toUpstream.binary().equals(key), "control mode forwards key events mid-stream");
      }
    }
  }

  assert.ok(feeds > expected.length, "frames really were split across multiple TCP chunks");

  const forwarded = h.toClient.read().filter((m) => m.opcode === OP_BINARY).map((m) => m.payload);
  assert.equal(forwarded.length, expected.length, "one binary message per framebuffer update");
  assert.ok(Buffer.concat(forwarded).equals(Buffer.concat(expected)), "every update arrives byte-identical and in order");

  assert.deepEqual(h.closes, [], "the bridge never fails during the soak");
  assert.deepEqual(
    h.bridge.getStatus(),
    { mode: "control", connected: true, spliced: true },
    "session is live and spliced after the soak",
  );
});

/** Build a FramebufferUpdate (type 0) with one RAW rect. */
function fbuRaw(w: number, h: number, fill = 0xab): Buffer {
  const rect = Buffer.alloc(12);
  rect.writeUInt16BE(w, 4);
  rect.writeUInt16BE(h, 6);
  rect.writeInt32BE(0, 8); // encoding RAW
  const header = Buffer.alloc(4);
  header[0] = 0; // FBU
  header.writeUInt16BE(1, 2); // one rect
  const pixels = Buffer.alloc(w * h * 4, fill);
  return Buffer.concat([header, rect, pixels]);
}

const recordingTmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-recording-"));

test("bridge: with recordFrames on, upstream frames are recorded and decode back in order", () => {
  const file = path.join(recordingTmp, "frames-1.rfb");
  const h = makeBridge("control", { recordFrames: true, recordingFile: file });
  handshake(h);

  const frameA = fbuRaw(2, 2, 0x11);
  const frameB = fbuRaw(3, 1, 0x22);
  h.upstream.feed(encodeFrame(OP_BINARY, Buffer.concat([frameA, frameB])));

  // The live forward path is unaffected: the RFB byte stream still reaches the
  // browser exactly as sent (both frames arrive, possibly in one WS message).
  const down = h.toClient.read().filter((m) => m.opcode === OP_BINARY);
  assert.equal(down.length, 1, "frames still forwarded while recording");
  assert.ok(down[0].payload.equals(Buffer.concat([frameA, frameB])), "byte-identical forward");
  assert.deepEqual(h.closes, []);

  // The recording file decodes back to exactly those frames, in order.
  const recorded = fs.readFileSync(file);
  const decoded = new RfbServerDecoder().push(recorded);
  assert.equal(decoded.length, 2);
  assert.ok(decoded[0].raw.equals(frameA), "first recorded frame matches");
  assert.ok(decoded[1].raw.equals(frameB), "second recorded frame matches");
});

test("bridge: input (browser→server) events are never written to the recording", () => {
  const file = path.join(recordingTmp, "frames-2.rfb");
  const h = makeBridge("control", { recordFrames: true, recordingFile: file });
  handshake(h);

  // A key event and a pointer event from the browser (the only direction that
  // carries input) must never reach the recorder.
  const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0x41]);
  const pointerEvent = Buffer.from([5, 1, 0, 10, 0, 20]);
  const encrypted = h.client.feed(encodeClientFrame(OP_BINARY, Buffer.concat([keyEvent, pointerEvent])));
  assert.ok(h.toUpstream.binary().length > 0, "input still forwarded in control mode");

  // Control messages that are not frames (Bell) are also excluded.
  h.upstream.feed(encodeFrame(OP_BINARY, Buffer.from([2]))); // Bell

  assert.equal(fs.readFileSync(file).length, 0, "recording stays empty — no input, no control bytes");
  assert.deepEqual(h.closes, []);
});

test("bridge: with recordFrames off, no recording file is created and forwarding is unchanged", () => {
  const file = path.join(recordingTmp, "should-not-exist.rfb");
  const h = makeBridge("control", { recordFrames: false, recordingFile: file });
  handshake(h);

  const frame = fbuRaw(4, 4);
  h.upstream.feed(encodeFrame(OP_BINARY, frame));
  const down = h.toClient.read();
  assert.equal(down.length, 1);
  assert.ok(down[0].payload.equals(frame), "forwarding byte-identical with recording off");
  assert.equal(fs.existsSync(file), false, "no recording file created");
  assert.deepEqual(h.closes, []);
});
