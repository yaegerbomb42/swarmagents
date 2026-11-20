import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import {
  forwardPreviewRequest,
  handlePreviewUpgrade,
  PreviewUpstreamError,
  rewriteCspFrameAncestors,
} from "./proxy";

/** A small "VM app": echoes method/path/headers and serves canned pages. */
function mockApp() {
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/framed") {
        res.writeHead(200, {
          "content-type": "text/html",
          "x-frame-options": "DENY",
          "content-security-policy": "default-src 'self'; frame-ancestors https://evil.example",
        });
        res.end("<h1>hi</h1>");
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/login" });
        res.end();
        return;
      }
      if (req.url === "/cookie") {
        res.writeHead(200, { "content-type": "text/plain", "set-cookie": "app_session=abc; Path=/; HttpOnly" });
        res.end("ok");
        return;
      }
      if (req.url === "/slow") {
        // Never answers; the proxy timeout must fire.
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  return { server, seen };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock app did not bind");
  return addr.port;
}

async function close(server: http.Server): Promise<void> {
  // Drop lingering keep-alive / never-answering connections (the /slow test
  // leaves one open on purpose) so the test process can exit.
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function input(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
) {
  const h = new Headers(headers);
  return {
    method,
    path,
    headers: h,
    body: body === undefined ? null : new Response(body).body,
  };
}

test("preview proxy: forwards method, path, query and body; strips identity headers", async (t) => {
  const { server, seen } = mockApp();
  const port = await listen(server);
  t.after(() => close(server));

  const res = await forwardPreviewRequest(
    input("POST", "/echo?x=1", {
      "content-type": "text/plain",
      cookie: "swarm_session=v2.alice.1234.deadbeef",
      authorization: "Bearer secret",
      "x-swarm-user": "alice",
      "x-custom": "kept",
    }, "hello"),
    { host: "127.0.0.1", port },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { method: string; url: string; body: string };
  assert.equal(body.method, "POST");
  assert.equal(body.url, "/echo?x=1");
  assert.equal(body.body, "hello");

  const upstream = seen[0];
  assert.equal(upstream.headers.cookie, undefined);
  assert.equal(upstream.headers.authorization, undefined);
  assert.equal(upstream.headers["x-swarm-user"], undefined);
  assert.equal(upstream.headers["x-custom"], "kept");
  // The browser's session cookie must never reach the untrusted VM app.
  assert.equal(JSON.stringify(upstream.headers).includes("swarm_session"), false);
});

test("preview proxy: framing headers are re-imposed, never inherited", async (t) => {
  const { server } = mockApp();
  const port = await listen(server);
  t.after(() => close(server));

  const res = await forwardPreviewRequest(input("GET", "/framed"), { host: "127.0.0.1", port });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(
    res.headers.get("content-security-policy"),
    "default-src 'self'; frame-ancestors 'self'",
  );
  assert.equal(await res.text(), "<h1>hi</h1>");

  const plain = await forwardPreviewRequest(input("GET", "/"), { host: "127.0.0.1", port });
  assert.equal(plain.headers.get("content-security-policy"), "frame-ancestors 'self'");
  assert.equal(plain.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("preview proxy: CSP rewrite only touches frame-ancestors", () => {
  assert.equal(rewriteCspFrameAncestors("default-src 'self'"), "default-src 'self'; frame-ancestors 'self'");
  assert.equal(
    rewriteCspFrameAncestors("frame-ancestors 'none'; script-src 'self'"),
    "frame-ancestors 'self'; script-src 'self'",
  );
  assert.equal(
    rewriteCspFrameAncestors("default-src 'none'; FRAME-ANCESTORS *"),
    "default-src 'none'; frame-ancestors 'self'",
  );
});

test("preview proxy: redirects and root-scoped cookies stay under the mount", async (t) => {
  const { server } = mockApp();
  const port = await listen(server);
  t.after(() => close(server));

  const redir = await forwardPreviewRequest(input("GET", "/redirect"), { host: "127.0.0.1", port }, { mountPrefix: "/preview/3000" });
  assert.equal(redir.headers.get("location"), "/preview/3000/login");

  const noMount = await forwardPreviewRequest(input("GET", "/redirect"), { host: "127.0.0.1", port });
  assert.equal(noMount.headers.get("location"), "/login");

  const cookie = await forwardPreviewRequest(input("GET", "/cookie"), { host: "127.0.0.1", port }, { mountPrefix: "/preview/3000" });
  assert.equal(cookie.headers.get("set-cookie"), "app_session=abc; Path=/preview/3000/; HttpOnly");
});

test("preview proxy: unreachable upstream and timeouts fail as PreviewUpstreamError", async () => {
  await assert.rejects(
    forwardPreviewRequest(input("GET", "/"), { host: "127.0.0.1", port: 1 }),
    (err: unknown) => err instanceof PreviewUpstreamError,
  );
  await assert.rejects(
    forwardPreviewRequest(input("GET", "/"), { host: "not a host!", port: 3000 }),
    (err: unknown) => err instanceof PreviewUpstreamError,
  );

  const { server } = mockApp();
  const port = await listen(server);
  try {
    await assert.rejects(
      forwardPreviewRequest(input("GET", "/slow"), { host: "127.0.0.1", port }, { timeoutMs: 200 }),
      (err: unknown) => err instanceof PreviewUpstreamError,
    );
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// WebSocket upgrades (handlePreviewUpgrade)
// ---------------------------------------------------------------------------

function wsAccept(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

/** One client -> server text frame (masked, as browsers send). */
function encodeClientFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const mask = randomBytes(4);
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.from([0x81, 0x80 | data.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** One server -> client text frame (unmasked). */
function encodeServerFrame(payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Pull complete text frames out of a byte stream. Frames carry their own
 * length, so the parser buffers until a whole frame has arrived; `onText`
 * fires once per frame with the (unmasked) payload.
 */
function frameParser(onText: (payload: Buffer) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 1) onText(Buffer.from(payload));
    }
  };
}

/**
 * A mock "VM app" with a WebSocket endpoint: handshakes, then echoes every
 * text frame back. Records the upgrade request headers so the test can
 * prove the proxy strips identity headers.
 */
function mockWsApp() {
  const seenUpgrades: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    seenUpgrades.push(req.headers);
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    socket.on("data", frameParser((payload) => {
      socket.write(encodeServerFrame(payload));
    }));
    // A well-behaved upstream closes its end when the client goes
    // away; otherwise the socket stays half-open forever and the
    // server's close() (which waits for it) hangs.
    socket.on("end", () => socket.destroy());
  });
  return { server, seenUpgrades };
}

/** A mock "VM app" whose socket endpoint answers 404 to the upgrade. */
function mockWsRefuser() {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (_req, socket) => {
    // end() (not write + destroy()): a graceful FIN lets the proxy's
    // http client read the full 404 response and relay it; destroy()
    // resets the connection and the proxy sees ECONNRESET -> 502.
    // NOTE: the body "not a sock" is 10 bytes — Content-Length must
    // match it exactly, or the client's parser errors on the trailing
    // byte and the proxy returns 502 instead of relaying the 404.
    socket.end(
      "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 10\r\nConnection: close\r\n\r\nnot a sock",
    );
  });
  return server;
}

/**
 * A raw "edge" server: its upgrade handler is handlePreviewUpgrade, the
 * way a custom Next server or the desktop proxy would wire it. The target
 * is chosen by the test, never by the client.
 */
function edgeServer(getTarget: () => { host: string; port: number }): http.Server {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    void handlePreviewUpgrade(req, socket, head, getTarget(), req.url ?? "/");
  });
  return server;
}

/** Dial the edge server as a WebSocket client; resolves on 101 or response. */
function wsDial(
  port: number,
  extraHeaders: Record<string, string> = {},
): Promise<
  | { kind: "upgraded"; socket: net.Socket }
  | { kind: "response"; res: http.IncomingMessage; body: string }
> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/",
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...extraHeaders,
      },
    });
    req.on("upgrade", (_res, socket) => resolve({ kind: "upgraded", socket }));
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ kind: "response", res, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("preview WS upgrade: a text frame round-trips through the proxy", async (t) => {
  const upstream = mockWsApp();
  const upstreamPort = await listen(upstream.server);

  const edge = edgeServer(() => ({ host: "127.0.0.1", port: upstreamPort }));
  const edgePort = await listen(edge);

  // One ordered cleanup: destroy the client socket first so the
  // handler's tunnel teardown destroys the upstream socket, then
  // close both servers. server.close() waits for the tunnel sockets,
  // and closeAllConnections() does not drop upgrade sockets, so
  // closing the servers before the tunnel is torn down hangs.
  let clientSocket: net.Socket | undefined;
  t.after(async () => {
    clientSocket?.destroy();
    await close(upstream.server);
    await close(edge);
  });

  const dialed = await wsDial(edgePort, {
    Cookie: "swarm_session=secret",
    Authorization: "Bearer secret",
  });
  assert.equal(dialed.kind, "upgraded");
  if (dialed.kind !== "upgraded") return;
  clientSocket = dialed.socket;
  const socket = dialed.socket;

  const echoed = new Promise<string>((resolve) => {
    socket.on("data", frameParser((payload) => resolve(payload.toString("utf8"))));
  });
  socket.write(encodeClientFrame("hello hmr"));
  assert.equal(await echoed, "hello hmr");

  // The upgrade handshake reached the app with the session stripped.
  assert.equal(upstream.seenUpgrades.length, 1);
  assert.equal(upstream.seenUpgrades[0]?.cookie, undefined);
  assert.equal(upstream.seenUpgrades[0]?.authorization, undefined);
  assert.equal(upstream.seenUpgrades[0]?.["sec-websocket-key"]?.length, 24);
});

test("preview WS upgrade: an upstream non-101 response is relayed, not dropped", async (t) => {
  const refuser = mockWsRefuser();
  const refuserPort = await listen(refuser);
  t.after(() => close(refuser));

  const edge = edgeServer(() => ({ host: "127.0.0.1", port: refuserPort }));
  const edgePort = await listen(edge);
  t.after(() => close(edge));

  const dialed = await wsDial(edgePort);
  assert.equal(dialed.kind, "response");
  if (dialed.kind !== "response") return;
  assert.equal(dialed.res.statusCode, 404);
  assert.equal(dialed.body, "not a sock");
});

test("preview WS upgrade: an invalid target and a plain HTTP request fail fast", async (t) => {
  const edge = edgeServer(() => ({ host: "not a host!", port: 3000 }));
  const edgePort = await listen(edge);
  t.after(() => close(edge));

  const dialed = await wsDial(edgePort);
  assert.equal(dialed.kind, "response");
  if (dialed.kind !== "response") return;
  assert.equal(dialed.res.statusCode, 502);

  // An upgrade request that fails the handler's validation (here: no
  // Sec-WebSocket-Key) is rejected with 400. A plain GET never reaches
  // handlePreviewUpgrade — the edge server's own request handler
  // answers it — so the probe must carry Upgrade headers. It also
  // needs an edge server with a VALID target: the handler validates
  // the target first, so an invalid target returns 502 before the
  // key check is ever reached. (The key check rejects before any
  // dial, so the valid target is never actually connected to.)
  const goodEdge = edgeServer(() => ({ host: "127.0.0.1", port: 3000 }));
  const goodEdgePort = await listen(goodEdge);
  t.after(() => close(goodEdge));

  const raw = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(goodEdgePort, "127.0.0.1", () => {
      socket.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400 Bad Request/);
});
