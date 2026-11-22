/**
 * RfbServerHandshake / RfbClientHandshake unit tests: the RFC 6143
 * server-first ordering on both ends, split-feed tolerance, and error
 * paths.
 *
 * The ordering tests are the regression guard for the desktop handshake
 * deadlock: the proxy used to wait for the browser's version string before
 * sending anything (and sent its own version first toward the container),
 * while real noVNC waits for the server version — both sides waited and
 * every desktop connection died on the 15 s handshake timeout.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  RfbServerHandshake,
  RfbClientHandshake,
  RFB_VERSION,
  SECURITY_NONE,
  SECURITY_VNC_AUTH,
  vncDesResponse,
} from "./rfb";

const VERSION = Buffer.from(RFB_VERSION);

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

// --- RfbServerHandshake (proxy plays the server toward the browser) ---

test("server handshake: start() emits the version string immediately, once", () => {
  const hs = new RfbServerHandshake();
  assert.equal(hs.start().toString(), RFB_VERSION);
  assert.equal(hs.start().length, 0, "version is sent exactly once");
});

test("server handshake: security types follow the client's version reply (not bundled with the version)", () => {
  const hs = new RfbServerHandshake();
  hs.start();
  const { out } = hs.feed(VERSION);
  assert.deepEqual([...out], [1, SECURITY_NONE]);
});

test("server handshake: full sequence completes and surplus is preserved", () => {
  const hs = new RfbServerHandshake();
  hs.start();
  hs.feed(VERSION);
  const sel = hs.feed(Buffer.from([SECURITY_NONE]));
  assert.deepEqual([...sel.out], [0, 0, 0, 0], "SecurityResult OK for None (3.8)");
  assert.equal(hs.done, false);
  const tail = Buffer.from([3, 1, 0, 0]); // start of a framebuffer-update request
  const fin = hs.feed(Buffer.concat([Buffer.from([1]), tail])); // ClientInit + pipelined bytes
  assert.equal(hs.done, true);
  assert.ok(fin.surplus.equals(tail), "bytes after ClientInit are surplus");
});

test("server handshake: version reply split across feeds is buffered", () => {
  const hs = new RfbServerHandshake();
  hs.start();
  assert.equal(hs.feed(VERSION.subarray(0, 5)).out.length, 0, "nothing until the full version arrives");
  const { out } = hs.feed(VERSION.subarray(5));
  assert.deepEqual([...out], [1, SECURITY_NONE]);
});

test("server handshake: invalid client version string throws", () => {
  const hs = new RfbServerHandshake();
  hs.start();
  assert.throws(() => hs.feed(Buffer.from("HELLO WORLD!")), /invalid RFB version/);
});

// --- RfbClientHandshake (proxy plays the client toward the container) ---

test("client handshake: start() sends nothing — the server speaks first", () => {
  const hs = new RfbClientHandshake("pw");
  assert.equal(hs.start().length, 0);
});

test("client handshake: version reply is emitted only after the server banner", () => {
  const hs = new RfbClientHandshake("pw");
  const { out } = hs.feed(VERSION);
  assert.equal(out.toString(), RFB_VERSION);
});

test("client handshake: banner split across feeds is buffered", () => {
  const hs = new RfbClientHandshake("pw");
  assert.equal(hs.feed(VERSION.subarray(0, 7)).out.length, 0, "nothing until the full banner arrives");
  const { out } = hs.feed(VERSION.subarray(7));
  assert.equal(out.toString(), RFB_VERSION);
});

test("client handshake: VNCAuth flow — choice, DES response, ClientInit, ServerInit", () => {
  const hs = new RfbClientHandshake("s3cret-pw");
  const challenge = crypto.randomBytes(16);
  let r = hs.feed(Buffer.concat([VERSION, Buffer.from([2, SECURITY_VNC_AUTH, SECURITY_NONE])]));
  assert.ok(
    r.out.equals(Buffer.concat([VERSION, Buffer.from([SECURITY_VNC_AUTH])])),
    "version reply + VNCAuth chosen",
  );
  r = hs.feed(challenge);
  assert.ok(r.out.equals(vncDesResponse("s3cret-pw", challenge)), "challenge answered with the injected password");
  r = hs.feed(Buffer.from([0, 0, 0, 0]));
  assert.deepEqual([...r.out], [1], "ClientInit: shared");
  r = hs.feed(serverInit(1280, 720));
  assert.equal(hs.done, true);
  assert.equal(hs.width, 1280);
  assert.equal(hs.height, 720);
});

test("client handshake: None-only server completes without a challenge", () => {
  const hs = new RfbClientHandshake("pw");
  let r = hs.feed(Buffer.concat([VERSION, Buffer.from([1, SECURITY_NONE])]));
  assert.ok(r.out.equals(Buffer.concat([VERSION, Buffer.from([SECURITY_NONE])])));
  r = hs.feed(Buffer.from([0, 0, 0, 0]));
  assert.deepEqual([...r.out], [1], "ClientInit: shared");
  hs.feed(serverInit());
  assert.equal(hs.done, true);
});

test("client handshake: ServerInit split across feeds is buffered", () => {
  const hs = new RfbClientHandshake("pw");
  hs.feed(Buffer.concat([VERSION, Buffer.from([1, SECURITY_NONE])]));
  hs.feed(Buffer.from([0, 0, 0, 0]));
  const init = serverInit(1024, 768, "split-name");
  hs.feed(init.subarray(0, 10));
  assert.equal(hs.done, false);
  hs.feed(init.subarray(10, 26));
  assert.equal(hs.done, false);
  hs.feed(init.subarray(26));
  assert.equal(hs.done, true);
  assert.equal(hs.width, 1024);
  assert.equal(hs.height, 768);
});

test("client handshake: invalid server banner throws", () => {
  const hs = new RfbClientHandshake("pw");
  assert.throws(() => hs.feed(Buffer.from("NOT RFB AT ALL")), /invalid RFB version/);
});

test("client handshake: security failure (count 0) throws", () => {
  const hs = new RfbClientHandshake("pw");
  hs.feed(VERSION);
  assert.throws(() => hs.feed(Buffer.from([0, 0, 0, 0, 0])), /security failure/);
});

test("client handshake: rejected authentication throws", () => {
  const hs = new RfbClientHandshake("pw");
  hs.feed(Buffer.concat([VERSION, Buffer.from([1, SECURITY_NONE])]));
  assert.throws(() => hs.feed(Buffer.from([0, 0, 0, 1])), /rejected the authentication/);
});
