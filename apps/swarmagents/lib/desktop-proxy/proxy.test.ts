/**
 * Integration tests for the desktop proxy (lib/desktop-proxy).
 *
 * A fake driver resolves per-user desktop endpoints pointing at scripted fake
 * VNC upstream servers (real HTTP + WebSocket + RFB server handshakes, with
 * VNCAuth challenge/response verified against the password the driver would
 * hold). The proxy is exercised through a real WebSocket client.
 *
 * Coverage: authentication (401), per-user endpoint isolation (no cross-user
 * or SSRF-style targeting), view-only enforcement, control takeover, password
 * secrecy (never in any response or upstream URL), connection limits, idle
 * timeout, and audit entries (desktop.view / desktop.takeover).
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
import { readAuditEntries, configureAuditPath } from "../audit";
import { createDesktopProxy, DESKTOP_WS_PATH, type DesktopProxy } from "./proxy";
import { issueWsTicket, WS_TICKET_TTL_MS } from "../rooms/ws-ticket";
import {
  encodeFrame,
  encodeClientFrame,
  decodeFrames,
  OP_BINARY,
  OP_TEXT,
  OP_PING,
  OP_PONG,
  OP_CLOSE,
  type WsMessage,
} from "./ws";
import type { PreviewTarget } from "../preview/proxy";
import type { PreviewShareOwner } from "../preview/tokens";
import { vncDesResponse, RFB_VERSION, SECURITY_NONE } from "./rfb";
import { RfbServerDecoder } from "./rfb-server";
import type { VmDesktopEndpoint } from "../vm/types";
import { createProject, createShareLink, configureProjectStoreDir } from "../projects/store";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// --- environment ------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-proxy-test-"));
process.env.SWARM_HOME = TMP;
process.env.SWARM_SERVER_MODE = "1";
// Server mode denies any Host not in the allowlist (Tier 2 #18: unset no
// longer means allow-all), so name the loopback host this proxy listens on.
process.env.SWARM_ALLOWED_HOSTS = "127.0.0.1";
process.env.SWARM_SESSION_SECRET = "test-secret";
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
  rawStream: Buffer[] = [];
  receivedAll: Buffer[] = [];

  private constructor(
    private readonly sock: net.Socket,
    head?: Buffer,
  ) {
    sock.on("data", (chunk: Buffer) => this.onData(chunk));
    sock.on("close", () => {
      this.closed = true;
      this.flushWaiters(new Error("socket closed"));
    });
    sock.on("error", () => {});
    // Bytes that arrived in the same read as the 101 response land in the
    // upgrade event's `head`, not in a later 'data' event. The bridge is
    // server-first now (it writes its RFB version frame immediately), so
    // dropping `head` would eat the version frame whenever the two writes
    // coalesce — feed it through the same path as socket data.
    if (head && head.length > 0) this.onData(head);
  }

  private onData(chunk: Buffer): void {
    this.rawStream.push(chunk);
    const { messages, rest } = decodeFrames(Buffer.concat([this.rest, chunk]));
    this.rest = rest;
    for (const m of messages) {
      if (m.opcode === OP_PING) {
        this.sock.write(encodeFrame(OP_PONG, m.payload));
      } else if (m.opcode === OP_PONG) {
        // ignore
      } else if (m.opcode === OP_CLOSE) {
        this.sock.end(encodeClientFrame(OP_CLOSE, m.payload));
      } else if (m.opcode === OP_BINARY) {
        this.receivedAll.push(m.payload);
        this.queue.push(m.payload);
      }
    }
    this.flushWaiters();
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<TestWsClient> {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: u.hostname,
        port: Number(u.port || (u.protocol === "wss:" ? 443 : 80)),
        path: u.pathname + u.search,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": key,
          ...headers,
        },
      });
      req.on("upgrade", (_res, sock, head) => resolve(new TestWsClient(sock as net.Socket, head)));
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
  // RFB is server-first (RFC 6143): the server sends its version string
  // immediately on connect; the client replies with its own, and only then
  // does the server advertise security types. Sending nothing until the
  // version arrives is what real noVNC does — and what deadlocked against
  // the old proxy, which waited for the client to speak first.
  const version = await client.next();
  assert.equal(version.toString("utf8"), "RFB 003.008\n", "server version arrives first");
  client.sendBinary(Buffer.from("RFB 003.008\n"));
  const types = await client.next();
  assert.equal(types[0], 1, "server advertises one security type");
  assert.equal(types[1], SECURITY_NONE, "server advertises None");
  client.sendBinary(Buffer.from([SECURITY_NONE]));
  const result = await client.next();
  assert.deepEqual([...result], [0, 0, 0, 0], "security result OK");
  client.sendBinary(Buffer.from([1])); // ClientInit: shared
  const serverInit = await client.next();
  assert.ok(serverInit.length >= 28, "ServerInit received");
}

// --- fake upstream VNC server ------------------------------------------------

const allFakeServers: FakeVncServer[] = [];
const allFakeWsApps: FakeWsApp[] = [];

test.after(() => {
  for (const s of allFakeServers) s.close();
  for (const s of allFakeWsApps) s.close();
});

class FakeVncServer {
  readonly server: http.Server;
  port = 0;
  received: Buffer[] = [];
  urls: string[] = [];
  readonly challenge = crypto.randomBytes(16);
  assets = new Map<string, string>();
  private sockets = new Set<net.Socket>();

  constructor(private readonly password: string) {
    this.server = http.createServer((req, res) => {
      this.urls.push(`HTTP ${req.method} ${req.url}`);
      const key = req.url ?? "/";
      const body = this.assets.get(key) ?? "404";
      res.writeHead(this.assets.has(key) ? 200 : 404, { "content-type": "text/html" });
      res.end(body);
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
    this.urls.push(`WS ${req.url}`);
    this.sockets.add(socket);
    // The proxy may reset an upstream socket while tearing down a session.
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
    // The proxy speaks RFC 6455 WebSocket frames in both directions, so each
    // inbound chunk is decoded into frames first and the RFB phase machine runs
    // over the binary payloads.
    let wsBuf: Buffer = Buffer.alloc(0);
    let rfbBuf: Buffer = Buffer.alloc(0);
    let phase: "version" | "select" | "challenge" | "auth-result" | "stream" = "version";
    const send = (payload: Buffer) => socket.write(encodeFrame(OP_BINARY, payload));
    // RFB is server-first (RFC 6143): send the version string immediately,
    // before reading anything from the client.
    send(Buffer.from("RFB 003.008\n"));

    function serverInit(): Buffer {
      const name = Buffer.from("fake-vnc");
      // 20-byte fixed part + U32 name length + name (RFC 6143 ServerInit).
      const init = Buffer.alloc(24 + name.length);
      init.writeUInt16BE(1280, 0);
      init.writeUInt16BE(800, 2);
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
          try {
            if (phase === "version") {
              if (rfbBuf.length < 12) break;
              rfbBuf = rfbBuf.subarray(12); // client version
              // The server advertises its security types immediately after the
              // version exchange: VNCAuth (2) then None (1).
              send(Buffer.from([2, 2, 1]));
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
              this.received.push(rfbBuf);
              rfbBuf = Buffer.alloc(0);
              break;
            }
          } catch {
            socket.destroy();
            return;
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

/** A mock "VM app" with a WebSocket endpoint that echoes frames back. */
class FakeWsApp {
  readonly server: http.Server;
  port = 0;
  urls: string[] = [];
  seenUpgrades: Array<{ url: string; cookie: string | undefined; authorization: string | undefined }> = [];
  private sockets = new Set<net.Socket>();

  constructor() {
    this.server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket as net.Socket));
    allFakeWsApps.push(this);
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  close(): void {
    for (const s of this.sockets) s.destroy();
    this.server.close();
  }

  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    this.urls.push(`WS ${req.url}`);
    this.seenUpgrades.push({
      url: req.url ?? "/",
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    });
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
    // Echo data frames back as binary; answer pings; close on close.
    let buf: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = decodeFrames(buf);
      buf = rest;
      for (const m of messages) {
        if (m.opcode === OP_PING) socket.write(encodeFrame(OP_PONG, m.payload));
        else if (m.opcode === OP_BINARY || m.opcode === OP_TEXT) {
          socket.write(encodeFrame(OP_BINARY, m.payload));
        } else if (m.opcode === OP_CLOSE) socket.end();
      }
    });
    socket.on("end", () => socket.destroy());
  }
}

// --- fake driver + proxy harness ---------------------------------------------

interface HarnessEndpoints {
  alice: VmDesktopEndpoint;
  bob: VmDesktopEndpoint;
  carol: VmDesktopEndpoint | null;
  /** Agent desktops, keyed by agent owner key (`agent:<id>:<userId>`). */
  [ownerKey: string]: VmDesktopEndpoint | null;
}

const GUEST_TOKEN = "guest-token";
/** Preview share token the harness resolves to alice's port 3000. */
const PREVIEW_SHARE_TOKEN = "a".repeat(48);

async function makeProxy(opts: {
  idleMs?: number;
  maxViewers?: number;
  // Partial: makeProxy fills alice/bob/carol defaults; callers only override what they need.
  endpoints?: Partial<HarnessEndpoints>;
  resolveGuest?: (token: string) => Promise<string | null>;
  resolvePreviewTarget?: (userId: string, port: number) => Promise<PreviewTarget | null>;
  resolvePreviewShare?: (token: string) => PreviewShareOwner | null;
  recordFrames?: boolean;
  recordingDir?: string;
  isActiveRun?: (userId: string, runId: string) => boolean;
  now?: () => number;
} = {}): Promise<{
  proxy: DesktopProxy;
  port: number;
  aliceVm: FakeVncServer;
  bobVm: FakeVncServer;
  aliceApp: FakeWsApp;
  bobApp: FakeWsApp;
}> {
  const aliceVm = new FakeVncServer("alice-vnc-password");
  const bobVm = new FakeVncServer("bob-vnc-password");
  await aliceVm.listen();
  await bobVm.listen();
  const aliceApp = new FakeWsApp();
  const bobApp = new FakeWsApp();
  await aliceApp.listen();
  await bobApp.listen();
  const endpoints: HarnessEndpoints = {
    alice: { host: "127.0.0.1", port: aliceVm.port, password: "alice-vnc-password" },
    bob: { host: "127.0.0.1", port: bobVm.port, password: "bob-vnc-password" },
    carol: null,
    ...(opts.endpoints ?? {}),
  };
  const resolveEndpoint = async (userId: string): Promise<VmDesktopEndpoint | null> =>
    endpoints[userId as keyof HarnessEndpoints] ?? null;

  const proxy = createDesktopProxy({
    now: opts.now,
    resolveEndpoint,
    resolveGuest:
      opts.resolveGuest ??
      (async (token: string): Promise<string | null> =>
        token === GUEST_TOKEN ? "alice" : null),
    // Preview targets: only port 3000 is "listening" in each user's VM;
    // anything else resolves to null, exactly as the real choke point
    // refuses an unlisted port.
    resolvePreviewTarget:
      opts.resolvePreviewTarget ??
      (async (userId: string, port: number): Promise<PreviewTarget | null> => {
        if (port !== 3000) return null;
        if (userId === "alice") return { host: "127.0.0.1", port: aliceApp.port };
        if (userId === "bob") return { host: "127.0.0.1", port: bobApp.port };
        return null;
      }),
    resolvePreviewShare:
      opts.resolvePreviewShare ??
      ((token: string): PreviewShareOwner | null =>
        token === PREVIEW_SHARE_TOKEN ? { ownerId: "alice", port: 3000, createdAt: 0 } : null),
    // Ephemeral port: tests must not collide with a dev proxy or another
    // test process on the default 3778.
    port: 0,
    idleMs: opts.idleMs,
    maxViewersPerUser: opts.maxViewers,
    recordFrames: opts.recordFrames,
    recordingDir: opts.recordingDir,
    isActiveRun: opts.isActiveRun,
  });
  await proxy.listen();
  return { proxy, port: proxy.port, aliceVm, bobVm, aliceApp, bobApp };
}

function wsUrl(port: number, mode?: "view" | "control", run?: string): string {
  const query = [mode ? `mode=${mode}` : "", run ? `run=${encodeURIComponent(run)}` : ""].filter(Boolean);
  return `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}${query.length ? `?${query.join("&")}` : ""}`;
}

async function openDesktopSession(
  port: number,
  userId: string,
  mode?: "view" | "control",
  run?: string,
): Promise<TestWsClient> {
  const client = await TestWsClient.connect(wsUrl(port, mode, run), { cookie: sessionFor(userId) });
  await completeRfbClientHandshake(client);
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build a FramebufferUpdate (type 0) with one RAW rect. */
function fbuRaw(w: number, h: number, fill = 0xab): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0; // FBU
  header.writeUInt16BE(1, 2); // one rect
  const rect = Buffer.alloc(12);
  rect.writeUInt16BE(w, 4);
  rect.writeUInt16BE(h, 6);
  rect.writeUInt32BE(0, 8); // encoding RAW
  return Buffer.concat([header, rect, Buffer.alloc(w * h * 4, fill)]);
}

async function expectClosed(client: TestWsClient, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!client.closed) {
    if (Date.now() - start > timeoutMs) throw new Error("expected socket to close");
    await sleep(20);
  }
}

// --- tests -------------------------------------------------------------------

test("desktop proxy: unauthorized HTTP and WebSocket are rejected with 401", async () => {
  const { proxy, port } = await makeProxy();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/desktop/vnc.html`);
    assert.equal(res.status, 401);
    assert.equal(await res.text(), "Sign in required.");

    const bad = await TestWsClient.connect(wsUrl(port)).catch((e: Error) => e);
    assert.ok(bad instanceof Error, "upgrade without cookie is refused");
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: HTTP assets are proxied from the user's own container", async () => {
  const { proxy, port, aliceVm } = await makeProxy();
  aliceVm.assets.set("/vnc.html", "<html>vnc client assets</html>");
  aliceVm.assets.set("/logo.png", "PNGDATA");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/desktop/vnc.html`, {
      headers: { cookie: sessionFor("alice") },
    });
    if (res.status !== 200) console.error("[test-debug] asset fetch status", res.status, "body", await res.text().catch(() => "<no body>"), "urls", aliceVm.urls);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<html>vnc client assets</html>");
    assert.ok(aliceVm.urls.some((u) => u.includes("GET /vnc.html")));

    const png = await fetch(`http://127.0.0.1:${port}/desktop/logo.png`, {
      headers: { cookie: sessionFor("alice") },
    });
    assert.equal(png.status, 200);
    assert.equal(await png.text(), "PNGDATA");
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: ?agent= dials the agent's own desktop, never another's", async () => {
  const workerVm = new FakeVncServer("worker-2-vnc-password");
  await workerVm.listen();
  const { proxy, port, aliceVm } = await makeProxy({
    endpoints: {
      "agent:worker-2:alice": {
        host: "127.0.0.1",
        port: workerVm.port,
        password: "worker-2-vnc-password",
      },
    },
  });
  try {
    const client = await TestWsClient.connect(
      `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?mode=view&agent=worker-2`,
      { cookie: sessionFor("alice") },
    );
    await completeRfbClientHandshake(client);
    assert.ok(
      workerVm.urls.some((u) => u.startsWith("WS /websockify")),
      "the named agent's VNC server received the dial",
    );
    assert.ok(
      !aliceVm.urls.some((u) => u.startsWith("WS ")),
      "the default agent's desktop was not dialed for ?agent=worker-2",
    );
    client.close();

    const workerHits = workerVm.urls.length;
    const aliceHits = aliceVm.urls.length;
    const unknown = await TestWsClient.connect(
      `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?mode=view&agent=worker-9`,
      { cookie: sessionFor("alice") },
    ).catch((e: Error) => e);
    assert.ok(unknown instanceof Error, "an agent with no desktop is refused");
    assert.match(unknown.message, /HTTP 404/);
    assert.equal(workerVm.urls.length, workerHits, "no upstream was dialed for the unknown agent");
    assert.equal(aliceVm.urls.length, aliceHits, "no upstream was dialed for the unknown agent");
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: invalid ?agent= falls back to the default agent's desktop", async () => {
  const { proxy, port, aliceVm } = await makeProxy();
  try {
    const client = await TestWsClient.connect(
      `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?mode=view&agent=..%2Fescape`,
      { cookie: sessionFor("alice") },
    );
    await completeRfbClientHandshake(client);
    assert.ok(
      aliceVm.urls.some((u) => u.startsWith("WS /websockify")),
      "an invalid agent id falls back to A1's desktop, never an escape",
    );
    client.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: guests cannot request another agent's desktop", async () => {
  const workerVm = new FakeVncServer("worker-2-vnc-password");
  await workerVm.listen();
  const { proxy, port, aliceVm } = await makeProxy({
    endpoints: {
      "agent:worker-2:alice": {
        host: "127.0.0.1",
        port: workerVm.port,
        password: "worker-2-vnc-password",
      },
    },
  });
  try {
    // A guest dials with the share token (no session): even with
    // ?agent=worker-2 it must land on the owner's default desktop.
    const guest = await TestWsClient.connect(
      `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?mode=view&token=${GUEST_TOKEN}&agent=worker-2`,
    );
    await completeRfbClientHandshake(guest);
    assert.ok(
      aliceVm.urls.some((u) => u.startsWith("WS /websockify")),
      "the guest landed on the owner's default desktop",
    );
    assert.ok(
      !workerVm.urls.some((u) => u.startsWith("WS ")),
      "the guest never reached the named agent's desktop",
    );
    guest.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: path traversal never reaches the upstream or other routes", async () => {
  const { proxy, port, aliceVm } = await makeProxy();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/desktop/../api/health`, {
      headers: { cookie: sessionFor("alice") },
    });
    assert.equal(res.status, 404);
    const res2 = await fetch(`http://127.0.0.1:${port}/desktop/%2e%2e/api/health`, {
      headers: { cookie: sessionFor("alice") },
    });
    assert.equal(res2.status, 404);
    assert.ok(!aliceVm.urls.some((u) => u.includes("api/health")), "upstream never saw a traversal");
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: view session is read-only (input events dropped, framebuffer requests relayed)", async () => {
  const { proxy, port, aliceVm } = await makeProxy();
  try {
    const client = await openDesktopSession(port, "alice", "view");

    // FramebufferUpdateRequest must reach the container.
    const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    client.sendBinary(fbur);
    // KeyEvent must not.
    client.sendBinary(Buffer.from([4, 0, 0, 0, 85, 0]));
    // PointerEvent must not.
    client.sendBinary(Buffer.from([5, 1, 2, 0, 3, 0]));

    await sleep(150);
    const received = Buffer.concat(aliceVm.received);
    assert.ok(received.includes(fbur), "FramebufferUpdateRequest relayed");
    assert.ok(!received.includes(Buffer.from([4, 0, 0, 0, 85, 0])), "KeyEvent dropped");
    assert.ok(!received.includes(Buffer.from([5, 1, 2, 0, 3, 0])), "PointerEvent dropped");
    client.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: getBridgeStatus reports live bridge state, not the stored mode", async () => {
  const { proxy, port } = await makeProxy();
  try {
    assert.deepEqual(proxy.getBridgeStatus("alice"), [], "no sessions yet");
    assert.deepEqual(proxy.getBridgeStatus("nobody"), [], "unknown user has no sessions");
    const viewer = await openDesktopSession(port, "alice", "view");
    await sleep(150);
    let status = proxy.getBridgeStatus("alice");
    assert.equal(status.length, 1);
    assert.equal(status[0]!.mode, "view");
    assert.equal(status[0]!.connected, true);
    assert.equal(status[0]!.spliced, true);
    // Control is negotiated through the takeover machine, not flipped by
    // setUserMode: a control dial requests takeover and (agent paused by
    // default) is granted immediately, and the status follows each live
    // bridge. setUserMode("control") is only a safe point now — it no
    // longer promotes a view session that never requested control.
    const controller = await openDesktopSession(port, "alice", "control");
    await sleep(150);
    status = proxy.getBridgeStatus("alice");
    assert.equal(status.length, 2);
    assert.deepEqual(
      status.map((s) => s.mode).sort(),
      ["control", "view"],
      "the granted controller reports control, the viewer stays view",
    );
    // Runtime force-view demotes every live bridge immediately.
    proxy.setUserMode("alice", "view");
    assert.deepEqual(
      proxy.getBridgeStatus("alice").map((s) => s.mode),
      ["view", "view"],
      "force-view demotes the controller too",
    );
    viewer.close();
    controller.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: control takeover relays input events", async () => {
  const { proxy, port, aliceVm } = await makeProxy();
  try {
    const client = await openDesktopSession(port, "alice", "control");
    const key = Buffer.from([4, 1, 0, 0, 65, 0]);
    client.sendBinary(key);
    await sleep(150);
    assert.ok(Buffer.concat(aliceVm.received).includes(key), "control session relays key events");
    client.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: only the authenticated user's container is ever contacted", async () => {
  const { proxy, port, aliceVm, bobVm } = await makeProxy();
  try {
    const client = await openDesktopSession(port, "alice", "view");
    client.sendBinary(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    await sleep(150);
    assert.ok(aliceVm.urls.length > 0, "alice's VM was contacted");
    assert.equal(bobVm.urls.length, 0, "bob's VM was never contacted");
    assert.equal(bobVm.received.length, 0);
    client.close();

    // Even with hostile headers/params, the target stays alice's VM — and a
    // forged Host never reaches any VM at all: server mode denies Hosts
    // outside SWARM_ALLOWED_HOSTS (Tier 2 #18), so the hostile request is
    // refused at the host gate (403) instead of being routed.
    const before = Buffer.concat(aliceVm.received).length;
    let hostileErr: Error | null = null;
    try {
      await TestWsClient.connect(
        `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?host=8.8.8.8&port=9999`,
        { cookie: sessionFor("alice"), "x-forwarded-host": "evil.example", host: "evil.example" },
      );
    } catch (e) {
      hostileErr = e as Error;
    }
    assert.ok(hostileErr, "hostile request must be refused");
    assert.match(hostileErr.message, /HTTP 403/, "forged Host is refused at the host gate");
    assert.equal(Buffer.concat(aliceVm.received).length, before, "alice's VM received nothing from the hostile request");
    assert.equal(bobVm.urls.length, 0, "bob's VM still never contacted");
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: users without a desktop VM get 404, not a connection", async () => {
  const { proxy, port, aliceVm } = await makeProxy();
  try {
    const err = await TestWsClient.connect(wsUrl(port), { cookie: sessionFor("carol") }).catch((e: Error) => e);
    assert.ok(err instanceof Error, "carol has no endpoint");
    assert.equal(aliceVm.urls.length, 0);
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: password never appears in responses or upstream URLs", async () => {
  const { proxy, port, aliceVm } = await makeProxy();
  const password = Buffer.from("alice-vnc-password", "utf8");
  try {
    const client = await openDesktopSession(port, "alice", "view");
    client.sendBinary(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    await sleep(150);

    const raw = Buffer.concat(client.rawStream);
    assert.ok(raw.indexOf(password) === -1, "password bytes never sent to the browser");
    for (const message of client.receivedAll) {
      assert.ok(message.indexOf(password) === -1, "password absent from every browser-facing message");
    }
    for (const url of aliceVm.urls) {
      assert.ok(!url.includes("alice-vnc-password"), "password never in the upstream URL");
    }
    client.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: wrong upstream password tears the session down", async () => {
  const { proxy, port } = await makeProxy({
    endpoints: {
      alice: { host: "127.0.0.1", port: 0, password: "wrong-password" },
      bob: { host: "127.0.0.1", port: 0, password: "wrong-password" },
      carol: null,
    },
  });
  // Patch alice to point at a real upstream whose password differs.
  const aliceVm = new FakeVncServer("real-password");
  await aliceVm.listen();
  const { proxy: p2 } = await (async () => {
    const proxy2 = createDesktopProxy({
      resolveEndpoint: async (userId: string): Promise<VmDesktopEndpoint | null> =>
        userId === "alice"
          ? { host: "127.0.0.1", port: aliceVm.port, password: "wrong-password" }
          : null,
      port: 0,
      idleMs: 5000,
    });
    await proxy2.listen();
    return { proxy: proxy2 };
  })();
  try {
    await proxy.close();
    const client = await TestWsClient.connect(wsUrl(p2.port), { cookie: sessionFor("alice") });
    await expectClosed(client);
    assert.ok(aliceVm.urls.length > 0, "upstream was contacted");
  } finally {
    await p2.close();
  }
});

test("desktop proxy: connection limits — max 3 concurrent viewers per user", async () => {
  const { proxy, port } = await makeProxy({ maxViewers: 3 });
  try {
    const a = await openDesktopSession(port, "alice", "view");
    const b = await openDesktopSession(port, "alice", "view");
    const c = await openDesktopSession(port, "alice", "view");
    const err = await TestWsClient.connect(wsUrl(port), { cookie: sessionFor("alice") }).catch((e: Error) => e);
    assert.ok(err instanceof Error, "4th viewer rejected");
    a.close();
    b.close();
    c.close();
    // After closing one, a new viewer fits again.
    const d = await openDesktopSession(port, "alice", "view");
    d.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: only one control session per user at a time", async () => {
  const { proxy, port } = await makeProxy();
  try {
    const ctrl = await openDesktopSession(port, "alice", "control");
    const err = await TestWsClient.connect(wsUrl(port, "control"), { cookie: sessionFor("alice") }).catch((e: Error) => e);
    assert.ok(err instanceof Error, "second control session rejected");
    ctrl.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: idle sessions are closed", async () => {
  const { proxy, port } = await makeProxy({ idleMs: 150 });
  try {
    const client = await openDesktopSession(port, "alice", "view");
    // The proxy clamps idleMs to >= 1000ms; leave generous headroom so a
    // loaded CI box does not flake this timing test.
    await expectClosed(client, 10000);
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: audit log records desktop.view and desktop.takeover", async () => {
  const { proxy, port } = await makeProxy();
  try {
    const view = await openDesktopSession(port, "alice", "view");
    view.close();
    const ctrl = await openDesktopSession(port, "alice", "control");
    ctrl.close();
    await sleep(50);
    const entries = readAuditEntries("alice");
    assert.ok(entries.some((e) => e.action === "desktop.view" && e.result === "success"), "desktop.view logged");
    assert.ok(entries.some((e) => e.action === "desktop.takeover" && e.result === "success"), "desktop.takeover logged");
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: guest token opens a read-only session and control is never granted", async () => {
  const { proxy, port, aliceVm } = await makeProxy();
  try {
    const client = await TestWsClient.connect(
      `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?mode=control&token=${GUEST_TOKEN}`,
    );
    await completeRfbClientHandshake(client);

    const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const key = Buffer.from([4, 1, 0, 0, 65, 0]);
    client.sendBinary(fbur);
    client.sendBinary(key);
    await sleep(150);

    const received = Buffer.concat(aliceVm.received);
    assert.ok(received.includes(fbur), "FramebufferUpdateRequest relayed to the owner's VM");
    assert.ok(!received.includes(key), "guest KeyEvent dropped despite ?mode=control");
    client.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: unknown or missing guest token is refused", async () => {
  const { proxy, port } = await makeProxy();
  try {
    const bogus = await TestWsClient.connect(
      `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?token=bogus-token`,
    ).catch((e: Error) => e);
    assert.ok(bogus instanceof Error, "bogus guest token refused");

    const none = await TestWsClient.connect(
      `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?mode=view`,
    ).catch((e: Error) => e);
    assert.ok(none instanceof Error, "no session and no guest token refused");
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: guest sessions count toward the owner's viewer limit", async () => {
  const { proxy, port } = await makeProxy({ maxViewers: 2 });
  try {
    const g1 = await TestWsClient.connect(`ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?token=${GUEST_TOKEN}`);
    await completeRfbClientHandshake(g1);
    const g2 = await TestWsClient.connect(`ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?token=${GUEST_TOKEN}`);
    await completeRfbClientHandshake(g2);

    const third = await TestWsClient.connect(`ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?token=${GUEST_TOKEN}`).catch(
      (e: Error) => e,
    );
    assert.ok(third instanceof Error, "third guest session is over the owner's viewer limit");
    g1.close();
    g2.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: default resolveGuest honors the share token index", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-proxy-guest-store-"));
  configureProjectStoreDir(path.join(tmp, "store"));
  const aliceVm = new FakeVncServer("alice-vnc-password");
  await aliceVm.listen();
  try {
    const owner = createProject("alice", { name: "Shared" });
    const share = createShareLink("alice", owner.id);

    // Build the proxy with NO resolveGuest override so the store-backed default
    // is exercised.
    const proxy = createDesktopProxy({
      resolveEndpoint: async (userId: string): Promise<VmDesktopEndpoint | null> =>
        userId === "alice"
          ? { host: "127.0.0.1", port: aliceVm.port, password: "alice-vnc-password" }
          : null,
      port: 0,
    });
    await proxy.listen();
    try {
      const client = await TestWsClient.connect(
        `ws://127.0.0.1:${proxy.port}${DESKTOP_WS_PATH}?token=${share.token}`,
      );
      await completeRfbClientHandshake(client);
      const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      client.sendBinary(fbur);
      await sleep(150);
      assert.ok(
        Buffer.concat(aliceVm.received).includes(fbur),
        "guest with a real share token reaches the owner's VM view-only",
      );
      client.close();
    } finally {
      await proxy.close();
    }
  } finally {
    configureProjectStoreDir("");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- preview WebSocket wiring ------------------------------------------------
//
// These exercise the real wiring path — a WebSocket upgrade arriving at the
// proxy server under the preview mounts — not handlePreviewUpgrade in
// isolation (lib/preview/proxy.test.ts covers the handler itself).

test("preview WS: session-gated upgrade round-trips frames through the owner's VM app", async () => {
  const { proxy, port, aliceApp, bobApp } = await makeProxy();
  try {
    const client = await TestWsClient.connect(`ws://127.0.0.1:${port}/preview/3000/`, {
      cookie: sessionFor("alice"),
    });
    client.sendBinary(Buffer.from("hello hmr"));
    assert.equal((await client.next()).toString("utf8"), "hello hmr");
    assert.equal(aliceApp.seenUpgrades.length, 1);
    assert.equal(aliceApp.seenUpgrades[0]?.url, "/");
    // The session cookie never reaches the previewed app.
    assert.equal(aliceApp.seenUpgrades[0]?.cookie, undefined);
    assert.equal(aliceApp.seenUpgrades[0]?.authorization, undefined);
    assert.equal(bobApp.seenUpgrades.length, 0, "bob's app was never contacted");
    client.close();
  } finally {
    await proxy.close();
  }
});

test("preview WS: sub-path and query reach the upstream app", async () => {
  const { proxy, port, aliceApp } = await makeProxy();
  try {
    const client = await TestWsClient.connect(`ws://127.0.0.1:${port}/preview/3000/vite-hmr?x=1`, {
      cookie: sessionFor("alice"),
    });
    client.sendBinary(Buffer.from("ping"));
    assert.equal((await client.next()).toString("utf8"), "ping");
    assert.equal(aliceApp.seenUpgrades[0]?.url, "/vite-hmr?x=1");
    client.close();
  } finally {
    await proxy.close();
  }
});

test("preview WS: unauthenticated upgrade is refused with 401", async () => {
  const { proxy, port, aliceApp } = await makeProxy();
  try {
    const err = await TestWsClient.connect(`ws://127.0.0.1:${port}/preview/3000/`).catch(
      (e: Error) => e,
    );
    assert.ok(err instanceof Error, "upgrade without cookie is refused");
    assert.match(err.message, /HTTP 401/);
    assert.equal(aliceApp.seenUpgrades.length, 0, "upstream never dialed");
  } finally {
    await proxy.close();
  }
});

test("preview WS: unlisted port is a 404 and the upstream is never dialed", async () => {
  const { proxy, port, aliceApp } = await makeProxy();
  try {
    const err = await TestWsClient.connect(`ws://127.0.0.1:${port}/preview/4000/`, {
      cookie: sessionFor("alice"),
    }).catch((e: Error) => e);
    assert.ok(err instanceof Error, "unlisted port is refused");
    assert.match(err.message, /HTTP 404/);
    assert.equal(aliceApp.seenUpgrades.length, 0, "upstream never dialed");
  } finally {
    await proxy.close();
  }
});

test("preview WS: traversal path never reaches the upstream", async () => {
  const { proxy, port, aliceApp } = await makeProxy();
  try {
    const err = await TestWsClient.connect(`ws://127.0.0.1:${port}/preview/3000/%2e%2e/secret`, {
      cookie: sessionFor("alice"),
    }).catch((e: Error) => e);
    assert.ok(err instanceof Error, "traversal is refused");
    assert.match(err.message, /HTTP 404/);
    assert.equal(aliceApp.seenUpgrades.length, 0, "upstream never dialed");
  } finally {
    await proxy.close();
  }
});

test("preview WS: only the authenticated user's app is ever contacted", async () => {
  const { proxy, port, aliceApp, bobApp } = await makeProxy();
  try {
    const client = await TestWsClient.connect(`ws://127.0.0.1:${port}/preview/3000/`, {
      cookie: sessionFor("bob"),
    });
    client.sendBinary(Buffer.from("bob hmr"));
    assert.equal((await client.next()).toString("utf8"), "bob hmr");
    assert.equal(bobApp.seenUpgrades.length, 1);
    assert.equal(aliceApp.seenUpgrades.length, 0, "alice's app was never contacted");
    client.close();
  } finally {
    await proxy.close();
  }
});

test("preview WS: share token upgrade works without a session; wrong-port and bogus tokens are refused", async () => {
  const { proxy, port, aliceApp } = await makeProxy();
  try {
    const client = await TestWsClient.connect(
      `ws://127.0.0.1:${port}/preview/share/${PREVIEW_SHARE_TOKEN}/3000/`,
    );
    client.sendBinary(Buffer.from("shared hmr"));
    assert.equal((await client.next()).toString("utf8"), "shared hmr");
    assert.equal(aliceApp.seenUpgrades.length, 1);
    assert.equal(aliceApp.seenUpgrades[0]?.url, "/");
    client.close();

    const wrongPort = await TestWsClient.connect(
      `ws://127.0.0.1:${port}/preview/share/${PREVIEW_SHARE_TOKEN}/4000/`,
    ).catch((e: Error) => e);
    assert.ok(wrongPort instanceof Error, "token bound to another port is refused");
    assert.match(wrongPort.message, /HTTP 404/);

    const bogus = await TestWsClient.connect(
      `ws://127.0.0.1:${port}/preview/share/${"b".repeat(48)}/3000/`,
    ).catch((e: Error) => e);
    assert.ok(bogus instanceof Error, "bogus token is refused");
    assert.match(bogus.message, /HTTP 404/);
    assert.equal(aliceApp.seenUpgrades.length, 1, "refused tokens never dialed the upstream");
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: recordFrames + recordingDir writes upstream frames to a recording file", async () => {
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-recording-"));
  const { proxy, port, aliceVm } = await makeProxy({ recordFrames: true, recordingDir });
  try {
    const client = await openDesktopSession(port, "alice", "control");

    const frameA = fbuRaw(2, 2, 0x11);
    const frameB = fbuRaw(3, 1, 0x22);
    aliceVm.push(Buffer.concat([frameA, frameB]));
    // Let the upstream->proxy frame land and be recorded.
    await sleep(50);

    const files = fs.readdirSync(recordingDir).filter((f) => f.endsWith(".rfb"));
    assert.equal(files.length, 1, `exactly one recording file, got ${JSON.stringify(files)}`);
    assert.ok(files[0].startsWith("frames-alice-"), "file named after user + session");

    const recorded = fs.readFileSync(path.join(recordingDir, files[0]));
    const decoded = new RfbServerDecoder().push(recorded);
    assert.equal(decoded.length, 2);
    assert.ok(decoded[0].raw.equals(frameA), "first recorded frame exact");
    assert.ok(decoded[1].raw.equals(frameB), "second recorded frame exact");

    client.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: a run-tagged viewer writes a run-scoped recording", async () => {
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-run-recording-"));
  const { proxy, port, aliceVm } = await makeProxy({
    recordFrames: true,
    recordingDir,
    isActiveRun: (userId, runId) => userId === "alice" && runId === "run_1",
  });
  try {
    const client = await openDesktopSession(port, "alice", "view", "run_1");
    aliceVm.push(fbuRaw(2, 2, 0x33));
    await sleep(50);
    const files = fs.readdirSync(recordingDir).filter((f) => f.endsWith(".rfb"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^frames-run_1-\d+\.rfb$/, "filename is keyed to the run, not the viewer");
    client.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: a forged or stale run tag records nothing", async () => {
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-bad-run-tag-"));
  const { proxy, port, aliceVm } = await makeProxy({
    recordFrames: true,
    recordingDir,
    isActiveRun: (userId, runId) => userId === "alice" && runId === "run_1",
  });
  try {
    const forged = await openDesktopSession(port, "alice", "view", "run_2");
    const stale = await openDesktopSession(port, "bob", "view", "run_1");
    aliceVm.push(fbuRaw(2, 2, 0x44));
    await sleep(50);
    assert.deepEqual(fs.readdirSync(recordingDir), [], "no recording for an unverified run tag");
    forged.close();
    stale.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: recording off by default — no recording file is created", async () => {
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-norec-"));
  const { proxy, port, aliceVm } = await makeProxy({});
  try {
    const client = await openDesktopSession(port, "alice", "control");
    aliceVm.push(fbuRaw(1, 1));
    await sleep(50);
    assert.equal(fs.readdirSync(recordingDir).length, 0, "no recording dir/file when recordFrames is off");
    client.close();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: single-use WS ticket connects view-only once and rejects reuse or expiry", async () => {
  let fakeNow = 1_700_000_000_000;
  const { proxy, port, aliceVm } = await makeProxy({ now: () => fakeNow });
  try {
    const { ticket } = issueWsTicket("alice", fakeNow);

    // First connection with the fresh ticket succeeds (view-only).
    const client = await TestWsClient.connect(
      `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?mode=view&ticket=${encodeURIComponent(ticket)}`,
    );
    await completeRfbClientHandshake(client);
    const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    client.sendBinary(fbur);
    await sleep(100);
    assert.ok(Buffer.concat(aliceVm.received).includes(fbur));
    client.close();

    // Reusing the same ticket is rejected with 401.
    await assert.rejects(
      TestWsClient.connect(
        `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?mode=view&ticket=${encodeURIComponent(ticket)}`,
      ),
      /401/,
    );

    // Expired ticket is rejected with 401.
    const { ticket: expiring } = issueWsTicket("alice", fakeNow);
    fakeNow += WS_TICKET_TTL_MS + 1;
    await assert.rejects(
      TestWsClient.connect(
        `ws://127.0.0.1:${port}${DESKTOP_WS_PATH}?mode=view&ticket=${encodeURIComponent(expiring)}`,
      ),
      /401/,
    );
  } finally {
    await proxy.close();
  }
});
