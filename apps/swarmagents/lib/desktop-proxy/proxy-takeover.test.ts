/**
 * Desktop proxy takeover-negotiation tests (lib/desktop-proxy/proxy.ts +
 * takeover-session.ts).
 *
 * Control dials no longer grant at connect: they request takeover from the
 * per-user state machine. While the agent is live the session stays
 * view-filtered (HUMAN_REQUESTED) until a safe point grants it; a second
 * control dial is a 409; guests never enter the machine; a controller
 * disconnect returns the desktop to the agent; and the proxy-local
 * /desktop/takeover-state endpoint reports the caller's place in the
 * machine. Uses the HoldUpstream harness from proxy-handoff.test.ts.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { signSession, SESSION_COOKIE } from "../auth";
import { configureAuditPath } from "../audit";
import {
  createDesktopProxy,
  DESKTOP_TAKEOVER_STATE_PATH,
  DESKTOP_WS_PATH,
  type DesktopProxy,
} from "./proxy";
import { TakeoverSessionManager } from "./takeover-session";
import type { VmDesktopEndpoint } from "../vm/types";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-takeover-test-"));
process.env.SWARM_HOME = TMP;
process.env.SWARM_SERVER_MODE = "1";
process.env.SWARM_SESSION_SECRET = "test-secret";
// The server-mode host gate denies by default when SWARM_ALLOWED_HOSTS is
// unset, so the dials (Host: 127.0.0.1) must be allowlisted here.
process.env.SWARM_ALLOWED_HOSTS = "127.0.0.1";
configureAuditPath(path.join(TMP, "audit.jsonl"));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sessionFor(userId: string): string {
  return `${SESSION_COOKIE}=${signSession(userId)}`;
}

/** An upstream that accepts the WS upgrade and then holds the socket open. */
class HoldUpstream {
  readonly server: http.Server;
  port = 0;
  private readonly sockets = new Set<net.Socket>();

  constructor() {
    this.server = http.createServer();
    this.server.on("upgrade", (req, socket) => {
      const key = String(req.headers["sec-websocket-key"] ?? "");
      const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          "\r\n",
      );
      socket.on("error", () => {});
      this.sockets.add(socket as net.Socket);
    });
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
}

const upstreams: HoldUpstream[] = [];
after(() => {
  for (const up of upstreams) up.close();
});

interface DialResult {
  status: number;
  socket: net.Socket;
}

/** Send a raw HTTP Upgrade request and observe the proxy's response status. */
function dial(port: number, query: string, cookie?: string): Promise<DialResult> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      sock.write(
        `GET ${DESKTOP_WS_PATH}?${query} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          (cookie ? `Cookie: ${cookie}\r\n` : "") +
          "\r\n",
      );
    });
    let buf = "";
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = buf.slice(0, idx);
      resolve({ status: Number(head.split(" ")[1]), socket: sock });
    });
    sock.on("error", reject);
  });
}

async function makeProxy(overrides: { requestTimeoutMs?: number } = {}): Promise<{
  proxy: DesktopProxy;
  port: number;
}> {
  const up = new HoldUpstream();
  await up.listen();
  upstreams.push(up);
  const endpoint: VmDesktopEndpoint = { host: "127.0.0.1", port: up.port, password: "vnc-password" };
  const proxy = createDesktopProxy({
    resolveEndpoint: async (userId: string) => (userId === "alice" ? endpoint : null),
    resolveGuest: async (token: string) => (token === "guest-token" ? "alice" : null),
    port: 0,
    maxViewersPerUser: 3,
    // Fake exec: no VM in tests; summaries degrade to empty titles/files.
    takeoverSession: new TakeoverSessionManager({
      exec: async () => ({ exitCode: 0 }),
      requestTimeoutMs: overrides.requestTimeoutMs ?? 60_000,
    }),
  });
  await proxy.listen();
  return { proxy, port: proxy.port };
}

test("desktop proxy takeover: a control dial waits for the safe point, then grants", async () => {
  const { proxy, port } = await makeProxy();
  try {
    proxy.setAgentPaused("alice", false); // a run is live
    const dialed = await dial(port, "mode=control&client=tab-1", sessionFor("alice"));
    assert.equal(dialed.status, 101, "the control dial opens (request accepted)");
    await sleep(50);

    let snap = proxy.getTakeoverState("alice");
    assert.equal(snap.state, "HUMAN_REQUESTED");
    assert.equal(snap.controllerId, "tab-1");
    // The bridge stays view-filtered until the grant.
    assert.equal(proxy.getBridgeStatus("alice")[0]?.mode, "view");

    proxy.notifyTakeoverSafePoint("alice");
    snap = proxy.getTakeoverState("alice");
    assert.equal(snap.state, "HUMAN_DRIVING");
    assert.equal(proxy.getBridgeStatus("alice")[0]?.mode, "control");

    dialed.socket.destroy();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy takeover: a second control dial is a 409 while one is pending", async () => {
  const { proxy, port } = await makeProxy();
  try {
    proxy.setAgentPaused("alice", false);
    const first = await dial(port, "mode=control&client=tab-1", sessionFor("alice"));
    assert.equal(first.status, 101);
    const second = await dial(port, "mode=control&client=tab-2", sessionFor("alice"));
    assert.equal(second.status, 409, "one pending/active controller at a time");
    second.socket.destroy();
    first.socket.destroy();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy takeover: guests are forced to view and never enter the machine", async () => {
  const { proxy, port } = await makeProxy();
  try {
    const guest = await dial(port, "mode=control&token=guest-token&client=tab-9");
    assert.equal(guest.status, 101, "guest dial opens");
    await sleep(50);
    assert.equal(proxy.getBridgeStatus("alice")[0]?.mode, "view");
    const snap = proxy.getTakeoverState("alice");
    assert.equal(snap.state, "AGENT_DRIVING");
    assert.equal(snap.controllerId, null);
    guest.socket.destroy();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy takeover: view dials are untouched by the machine", async () => {
  const { proxy, port } = await makeProxy();
  try {
    const view = await dial(port, "mode=view&client=tab-1", sessionFor("alice"));
    assert.equal(view.status, 101);
    await sleep(50);
    assert.equal(proxy.getBridgeStatus("alice")[0]?.mode, "view");
    assert.equal(proxy.getTakeoverState("alice").state, "AGENT_DRIVING");
    view.socket.destroy();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy takeover: controller disconnect returns the desktop to the agent", async () => {
  const { proxy, port } = await makeProxy();
  try {
    // Agent paused (default): the dial grants immediately, as before.
    const dialed = await dial(port, "mode=control&client=tab-1", sessionFor("alice"));
    assert.equal(dialed.status, 101);
    await sleep(50);
    assert.equal(proxy.getTakeoverState("alice").state, "HUMAN_DRIVING");

    dialed.socket.destroy();
    await sleep(150);
    assert.equal(proxy.getTakeoverState("alice").state, "AGENT_DRIVING");
    assert.ok(proxy.getTakeoverSummary("alice"), "a handback summary was recorded");
  } finally {
    await proxy.close();
  }
});

test("desktop proxy takeover: the state endpoint is session-gated and reports the caller", async () => {
  const { proxy, port } = await makeProxy();
  try {
    const anon = await fetch(`http://127.0.0.1:${port}${DESKTOP_TAKEOVER_STATE_PATH}?client=tab-1`);
    assert.equal(anon.status, 401, "no session cookie, no state");

    proxy.setAgentPaused("alice", false);
    const dialed = await dial(port, "mode=control&client=tab-1", sessionFor("alice"));
    assert.equal(dialed.status, 101);

    const res = await fetch(`http://127.0.0.1:${port}${DESKTOP_TAKEOVER_STATE_PATH}?client=tab-1`, {
      headers: { cookie: sessionFor("alice") },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      state: string;
      isController: boolean;
      canAcceptInput: boolean;
      agentPaused: boolean;
    };
    assert.equal(body.state, "HUMAN_REQUESTED");
    assert.equal(body.isController, true);
    assert.equal(body.canAcceptInput, false);
    assert.equal(body.agentPaused, false);

    // A different client id is not the controller.
    const other = await fetch(`http://127.0.0.1:${port}${DESKTOP_TAKEOVER_STATE_PATH}?client=tab-2`, {
      headers: { cookie: sessionFor("alice") },
    });
    const otherBody = (await other.json()) as { isController: boolean };
    assert.equal(otherBody.isController, false);

    dialed.socket.destroy();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy takeover: the request timeout grants when no safe point comes", async () => {
  const { proxy, port } = await makeProxy({ requestTimeoutMs: 40 });
  try {
    proxy.setAgentPaused("alice", false);
    const dialed = await dial(port, "mode=control&client=tab-1", sessionFor("alice"));
    assert.equal(dialed.status, 101);
    await sleep(120);
    assert.equal(proxy.getTakeoverState("alice").state, "HUMAN_DRIVING");
    assert.equal(proxy.getBridgeStatus("alice")[0]?.mode, "control");
    dialed.socket.destroy();
  } finally {
    await proxy.close();
  }
});
