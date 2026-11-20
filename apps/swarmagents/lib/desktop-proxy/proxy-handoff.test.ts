/**
 * Desktop proxy mode-flip tests (lib/desktop-proxy/proxy.ts setUserMode).
 *
 * The runtime forces a user's desktop sessions to view mode while a
 * shadow-to-takeover handoff is outstanding, then restores control on
 * hand-back. This test exercises that flip behaviorally: a control session
 * blocks a second control takeover (409) until setUserMode demotes it to view,
 * after which a new control dial succeeds.
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
import { createDesktopProxy, DESKTOP_WS_PATH, type DesktopProxy } from "./proxy";
import type { VmDesktopEndpoint } from "../vm/types";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-handoff-test-"));
process.env.SWARM_HOME = TMP;
process.env.SWARM_SERVER_MODE = "1";
process.env.SWARM_SESSION_SECRET = "test-secret";
// The server-mode host gate denies by default when SWARM_ALLOWED_HOSTS is
// unset, so the dials (Host: 127.0.0.1) must be allowlisted here.
process.env.SWARM_ALLOWED_HOSTS = "127.0.0.1";
configureAuditPath(path.join(TMP, "audit.jsonl"));

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
function dial(port: number, userId: string, mode: "view" | "control"): Promise<DialResult> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      sock.write(
        `GET ${DESKTOP_WS_PATH}?mode=${mode} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Cookie: ${sessionFor(userId)}\r\n` +
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

async function makeProxy(): Promise<{ proxy: DesktopProxy; port: number }> {
  const up = new HoldUpstream();
  await up.listen();
  upstreams.push(up);
  const endpoint: VmDesktopEndpoint = { host: "127.0.0.1", port: up.port, password: "vnc-password" };
  const proxy = createDesktopProxy({
    resolveEndpoint: async (userId: string) => (userId === "alice" ? endpoint : null),
    port: 0,
    maxViewersPerUser: 3,
  });
  await proxy.listen();
  return { proxy, port: proxy.port };
}

test("desktop proxy: setUserMode flips a control session so a new takeover succeeds", async () => {
  const { proxy, port } = await makeProxy();
  try {
    const first = await dial(port, "alice", "control");
    assert.equal(first.status, 101, "first control takeover opens");

    const blocked = await dial(port, "alice", "control");
    assert.equal(blocked.status, 409, "a second control takeover is blocked while one is active");
    blocked.socket.destroy();

    // The runtime forces the session to view while a handoff is outstanding.
    proxy.setUserMode("alice", "view");

    const third = await dial(port, "alice", "control");
    assert.equal(third.status, 101, "after demotion to view, a new control takeover opens");
    third.socket.destroy();
    first.socket.destroy();
  } finally {
    await proxy.close();
  }
});

test("desktop proxy: setUserMode is a safe no-op for unknown users", async () => {
  const { proxy, port } = await makeProxy();
  try {
    assert.doesNotThrow(() => proxy.setUserMode("nobody", "view"));
    const view = await dial(port, "alice", "view");
    assert.equal(view.status, 101);
    proxy.setUserMode("alice", "view");
    assert.equal(proxy.activeSessions("alice"), 1);
    view.socket.destroy();
  } finally {
    await proxy.close();
  }
});
