/**
 * Keyframe read API tests (GET /desktop/keyframes + DesktopProxy methods).
 *
 * The fake VNC server here speaks first on upgrade (banner + security types
 * immediately, then reads version/select/DES/ClientInit). That ordering
 * works with both the current bridge and the RFB server-first handshake
 * fix, so this file does not depend on which lands first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { URL } from "node:url";
import { signSession, SESSION_COOKIE } from "../auth";
import { configureAuditPath } from "../audit";
import {
  createDesktopProxy,
  DESKTOP_KEYFRAMES_PATH,
  DESKTOP_WS_PATH,
  type DesktopProxy,
} from "./proxy";
import {
  encodeFrame,
  encodeClientFrame,
  decodeFrames,
  OP_BINARY,
  OP_PING,
  OP_PONG,
  OP_CLOSE,
  type WsMessage,
} from "./ws";
import { vncDesResponse, SECURITY_NONE } from "./rfb";
import type { VmDesktopEndpoint } from "../vm/types";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const FRAME_W = 64;
const FRAME_H = 64;

// --- environment ------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-keyframes-test-"));
process.env.SWARM_HOME = TMP;
process.env.SWARM_SERVER_MODE = "1";
process.env.SWARM_ALLOWED_HOSTS = "127.0.0.1";
process.env.SWARM_SESSION_SECRET = "keyframes-test-secret-0123456789abcdef";
configureAuditPath(path.join(TMP, "audit.jsonl"));

function sessionFor(userId: string): string {
  return `${SESSION_COOKIE}=${signSession(userId)}`;
}

// --- minimal WebSocket client (RFC 6455) -----------------------------------

class TestWsClient {
  private rest: Buffer = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private waiters: Array<{ resolve: (m: Buffer) => void; reject: (e: Error) => void }> = [];
  closed = false;

  private constructor(private readonly sock: net.Socket) {
    sock.on("data", (chunk: Buffer) => {
      const { messages, rest } = decodeFrames(Buffer.concat([this.rest, chunk]));
      this.rest = rest;
      for (const m of messages) {
        if (m.opcode === OP_PING) {
          this.sock.write(encodeFrame(OP_PONG, m.payload));
        } else if (m.opcode === OP_CLOSE) {
          this.sock.end(encodeClientFrame(OP_CLOSE, m.payload));
        } else if (m.opcode === OP_BINARY) {
          this.queue.push(m.payload);
        }
      }
      this.flushWaiters();
    });
    sock.on("close", () => {
      this.closed = true;
      this.flushWaiters(new Error("socket closed"));
    });
    sock.on("error", () => {});
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<TestWsClient> {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: u.hostname,
        port: Number(u.port || 80),
        path: u.pathname + u.search,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": key,
          ...headers,
        },
      });
      req.on("upgrade", (_res, sock) => resolve(new TestWsClient(sock as net.Socket)));
      req.on("response", (res) => {
        res.resume();
        reject(new Error(`expected upgrade, got HTTP ${res.statusCode}`));
      });
      req.on("error", reject);
      req.end();
    });
  }

  sendBinary(payload: Buffer): void {
    this.sock.write(encodeClientFrame(OP_BINARY, payload));
  }

  next(timeoutMs = 5000): Promise<Buffer> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private flushWaiters(err?: Error): void {
    while (this.waiters.length > 0 && (this.queue.length > 0 || err)) {
      const w = this.waiters.shift()!;
      if (this.queue.length > 0) w.resolve(this.queue.shift()!);
      else w.reject(err!);
    }
  }

  close(): void {
    this.sock.write(encodeClientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])));
    this.sock.destroy();
  }
}

/** Speak the RFB client side over a WebSocket until ServerInit is received. */
async function completeRfbClientHandshake(client: TestWsClient): Promise<void> {
  client.sendBinary(Buffer.from("RFB 003.008\n"));
  const first = await client.next();
  // The proxy may send version and security types in one frame or two.
  let version: Buffer;
  let types: Buffer;
  if (first.length >= 12 && first.subarray(0, 4).toString() === "RFB ") {
    version = first.subarray(0, 12);
    types = first.subarray(12);
    if (types.length === 0) types = await client.next();
  } else {
    version = first;
    types = await client.next();
  }
  assert.equal(version.toString("utf8"), "RFB 003.008\n");
  assert.equal(types[0], 1, "server advertises one security type");
  assert.equal(types[1], SECURITY_NONE, "server advertises None");
  client.sendBinary(Buffer.from([SECURITY_NONE]));
  const result = await client.next();
  assert.deepEqual([...result], [0, 0, 0, 0], "security result OK");
  client.sendBinary(Buffer.from([1])); // ClientInit: shared
  const serverInit = await client.next();
  assert.ok(serverInit.length >= 28, "ServerInit received");
}

// --- fake upstream VNC server (server-first, small framebuffer) ------------

const allFakeServers: FakeVncServer[] = [];
test.after(() => {
  for (const s of allFakeServers) s.close();
});

class FakeVncServer {
  readonly server: http.Server;
  port = 0;
  readonly challenge = crypto.randomBytes(16);
  private sockets = new Set<net.Socket>();

  constructor(private readonly password: string) {
    this.server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket as net.Socket));
    allFakeServers.push(this);
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("error", () => {});
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );
    this.runRfbServer(socket);
  }

  private runRfbServer(socket: net.Socket): void {
    let wsBuf: Buffer = Buffer.alloc(0);
    let rfbBuf: Buffer = Buffer.alloc(0);
    let phase: "version" | "select" | "challenge" | "auth-result" | "stream" = "version";
    const send = (payload: Buffer) => socket.write(encodeFrame(OP_BINARY, payload));

    // Server-first: banner + security types go out immediately. Works with
    // both the current bridge (which sends its version at construction and
    // consumes these when they arrive) and the server-first handshake fix
    // (which waits for the banner before replying).
    send(Buffer.from("RFB 003.008\n"));
    send(Buffer.from([2, 2, 1])); // VNCAuth (2), then None (1)

    function serverInit(): Buffer {
      const name = Buffer.from("fake-vnc");
      const init = Buffer.alloc(24 + name.length);
      init.writeUInt16BE(FRAME_W, 0);
      init.writeUInt16BE(FRAME_H, 2);
      init[4] = 32;
      init[5] = 24;
      init[7] = 1;
      init.writeUInt16BE(255, 8);
      init.writeUInt16BE(255, 10);
      init.writeUInt16BE(255, 12);
      init[14] = 16;
      init[15] = 8;
      init.writeUInt32BE(name.length, 20);
      name.copy(init, 24);
      return init;
    }

    socket.on("data", (chunk: Buffer) => {
      wsBuf = Buffer.concat([wsBuf, chunk]);
      let messages: WsMessage[];
      let rest: Buffer;
      try {
        ({ messages, rest } = decodeFrames(wsBuf));
      } catch {
        socket.destroy();
        return;
      }
      if (messages.length === 0) return;
      wsBuf = rest;
      for (const m of messages) {
        if (m.opcode === OP_PING) {
          socket.write(encodeFrame(OP_PONG, m.payload));
          continue;
        }
        if (m.opcode === OP_CLOSE) {
          socket.end(encodeFrame(OP_CLOSE, m.payload));
          return;
        }
        if (m.opcode !== OP_BINARY) continue;
        rfbBuf = Buffer.concat([rfbBuf, m.payload]);
        for (;;) {
          if (phase === "version") {
            if (rfbBuf.length < 12) break;
            rfbBuf = rfbBuf.subarray(12); // client version
            phase = "select";
          } else if (phase === "select") {
            if (rfbBuf.length < 1) break;
            rfbBuf = rfbBuf.subarray(1); // security choice
            send(this.challenge);
            phase = "challenge";
          } else if (phase === "challenge") {
            if (rfbBuf.length < 16) break;
            const response = rfbBuf.subarray(0, 16);
            rfbBuf = rfbBuf.subarray(16);
            const ok = response.equals(vncDesResponse(this.password, this.challenge));
            send(ok ? Buffer.from([0, 0, 0, 0]) : Buffer.from([0, 0, 0, 1]));
            phase = "auth-result";
          } else if (phase === "auth-result") {
            if (rfbBuf.length < 1) break;
            rfbBuf = rfbBuf.subarray(1); // ClientInit (shared) — then ServerInit
            send(serverInit());
            phase = "stream";
          } else {
            rfbBuf = Buffer.alloc(0);
            break;
          }
        }
      }
    });
  }

  close(): void {
    for (const s of this.sockets) s.destroy();
    this.server.close();
  }

  /** Push a server->client RFB payload to every connected upstream socket. */
  push(payload: Buffer): void {
    for (const s of this.sockets) s.write(encodeFrame(OP_BINARY, payload));
  }
}

// --- harness ----------------------------------------------------------------

interface Harness {
  proxy: DesktopProxy;
  aliceVm: FakeVncServer;
  bobVm: FakeVncServer;
}

async function makeProxy(opts: { frameTap?: boolean } = {}): Promise<Harness> {
  const aliceVm = new FakeVncServer("alice-vnc-password");
  const bobVm = new FakeVncServer("bob-vnc-password");
  await aliceVm.listen();
  await bobVm.listen();
  const endpoints: Record<string, VmDesktopEndpoint> = {
    alice: { host: "127.0.0.1", port: aliceVm.port, password: "alice-vnc-password" },
    bob: { host: "127.0.0.1", port: bobVm.port, password: "bob-vnc-password" },
  };
  const proxy = createDesktopProxy({
    port: 0,
    resolveEndpoint: async (userId) => endpoints[userId] ?? null,
    frameTap: opts.frameTap ? { storeOptions: { minIntervalMs: 0 } } : undefined,
  });
  await proxy.listen();
  return { proxy, aliceVm, bobVm };
}

async function openDesktopSession(proxy: DesktopProxy, userId: string): Promise<TestWsClient> {
  const client = await TestWsClient.connect(`http://127.0.0.1:${proxy.port}${DESKTOP_WS_PATH}`, {
    cookie: sessionFor(userId),
    origin: `http://127.0.0.1:${proxy.port}`,
  });
  await completeRfbClientHandshake(client);
  return client;
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function httpRequest(
  port: number,
  pathAndQuery: string,
  opts: { method?: string; cookie?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathAndQuery,
        method: opts.method ?? "GET",
        headers: opts.cookie ? { cookie: opts.cookie } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** One Raw rect update over the whole frame, uniform color, BGRA wire order. */
function rawUpdate(b: number, g: number, r: number): Buffer {
  const head = Buffer.alloc(4 + 12);
  head[0] = 0;
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(FRAME_W, 8);
  head.writeUInt16BE(FRAME_H, 10);
  head.writeInt32BE(0, 12);
  const px = Buffer.alloc(FRAME_W * FRAME_H * 4);
  for (let i = 0; i < FRAME_W * FRAME_H; i++) {
    px[i * 4] = b;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = r;
    px[i * 4 + 3] = 255;
  }
  return Buffer.concat([head, px]);
}

// --- tests --------------------------------------------------------------------

test("keyframe API requires a session (401 without one)", async () => {
  const { proxy } = await makeProxy({ frameTap: true });
  try {
    const res = await httpRequest(proxy.port, DESKTOP_KEYFRAMES_PATH);
    assert.equal(res.status, 401);
  } finally {
    await proxy.close();
  }
});

test("keyframe list is empty before any session captures frames", async () => {
  const { proxy } = await makeProxy({ frameTap: true });
  try {
    const res = await httpRequest(proxy.port, DESKTOP_KEYFRAMES_PATH, {
      cookie: sessionFor("alice"),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), { keyframes: [] });

    const head = await httpRequest(proxy.port, DESKTOP_KEYFRAMES_PATH, {
      method: "HEAD",
      cookie: sessionFor("alice"),
    });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
  } finally {
    await proxy.close();
  }
});

test("captured keyframes are listable and fetchable; other users see nothing", async () => {
  const { proxy, aliceVm } = await makeProxy({ frameTap: true });
  const client = await openDesktopSession(proxy, "alice");
  try {
    aliceVm.push(rawUpdate(0, 0, 255)); // red frame -> first-frame keyframe

    let list: Array<{ id: string; timestamp: number; sessionId: number; width: number }> = [];
    await waitFor(async () => {
      const res = await httpRequest(proxy.port, DESKTOP_KEYFRAMES_PATH, {
        cookie: sessionFor("alice"),
      });
      list = JSON.parse(res.body.toString("utf8")).keyframes;
      return list.length >= 1;
    });
    assert.equal(list[0]!.width, FRAME_W);
    assert.match(list[0]!.id, /^kf_\d+_\d+$/);

    // Fetch by id -> JPEG bytes.
    const byId = await httpRequest(proxy.port, `${DESKTOP_KEYFRAMES_PATH}/${list[0]!.id}`, {
      cookie: sessionFor("alice"),
    });
    assert.equal(byId.status, 200);
    assert.equal(byId.headers["content-type"], "image/jpeg");
    assert.equal(byId.body[0], 0xff);
    assert.equal(byId.body[1], 0xd8); // SOI
    assert.equal(byId.body.at(-2), 0xff);
    assert.equal(byId.body.at(-1), 0xd9); // EOI

    // Fetch nearest to a timestamp (at-or-before; also far-future falls back
    // to the latest at-or-before, and far-past to the earliest).
    const at = await httpRequest(
      proxy.port,
      `${DESKTOP_KEYFRAMES_PATH}/at/${list[0]!.timestamp}`,
      { cookie: sessionFor("alice") },
    );
    assert.equal(at.status, 200);
    assert.ok(at.body.equals(byId.body));

    // Unknown id -> 404; malformed id -> 404.
    const missing = await httpRequest(proxy.port, `${DESKTOP_KEYFRAMES_PATH}/kf_1_999`, {
      cookie: sessionFor("alice"),
    });
    assert.equal(missing.status, 404);
    const malformed = await httpRequest(proxy.port, `${DESKTOP_KEYFRAMES_PATH}/../secret`, {
      cookie: sessionFor("alice"),
    });
    assert.equal(malformed.status, 404);

    // Bob (a different user) sees none of alice's keyframes.
    const bobList = await httpRequest(proxy.port, DESKTOP_KEYFRAMES_PATH, {
      cookie: sessionFor("bob"),
    });
    assert.deepEqual(JSON.parse(bobList.body.toString("utf8")), { keyframes: [] });
    const bobFetch = await httpRequest(proxy.port, `${DESKTOP_KEYFRAMES_PATH}/${list[0]!.id}`, {
      cookie: sessionFor("bob"),
    });
    assert.equal(bobFetch.status, 404);

    // The DesktopProxy methods agree with the HTTP API.
    assert.equal(proxy.getKeyframes("alice").length, 1);
    assert.ok(proxy.getKeyframe("alice", list[0]!.id));
    assert.ok(proxy.getKeyframeAt("alice", list[0]!.timestamp));
    assert.equal(proxy.getKeyframe("bob", list[0]!.id), undefined);
    const latest = proxy.getLatestDesktopFrame("alice")!;
    assert.deepEqual([latest.rgba[0], latest.rgba[1], latest.rgba[2]], [255, 0, 0]);
    assert.equal(proxy.getLatestDesktopFrame("bob"), null);
  } finally {
    client.close();
    await proxy.close();
  }
});

test("without the frameTap option, sessions stream but capture nothing", async () => {
  const { proxy, aliceVm } = await makeProxy({ frameTap: false });
  const client = await openDesktopSession(proxy, "alice");
  try {
    aliceVm.push(rawUpdate(0, 255, 0));
    // The browser still receives the frame (tap off must not affect the stream).
    const forwarded = await client.next();
    assert.ok(forwarded.length > 0);
    const res = await httpRequest(proxy.port, DESKTOP_KEYFRAMES_PATH, {
      cookie: sessionFor("alice"),
    });
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), { keyframes: [] });
    assert.equal(proxy.getLatestDesktopFrame("alice"), null);
  } finally {
    client.close();
    await proxy.close();
  }
});
