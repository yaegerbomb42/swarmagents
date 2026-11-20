import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { VmManager, setVmManagerForTesting } from "../vm/manager";
import type { VmDriver } from "../vm/types";
import { clearPreviewPortsCache } from "./ports";
import { serveSessionPreview, serveSharedPreview } from "./serve";
import {
  configurePreviewShareDir,
  createPreviewShare,
  revokePreviewShare,
} from "./tokens";

function mockApp() {
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`app on ${req.url}`);
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

interface Harness {
  appPort: number;
  seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }): Promise<Harness> {
  const { server, seen } = mockApp();
  const appPort = await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-preview-serve-"));
  configurePreviewShareDir(dir);
  clearPreviewPortsCache();

  // The stub VM "listens" on the mock app's port and its container IP is
  // loopback, so the proxy dials the mock app exactly like a real container.
  const ssOutput = [
    "Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
    `tcp LISTEN 0 4096 0.0.0.0:${appPort} 0.0.0.0:* users:(("node",pid=12,fd=20))`,
  ].join("\n");
  const driver = {
    ensure: async (userId: string) => ({ userId, containerName: `vm-${userId}`, createdAt: 0 }),
    exec: async (_handle: unknown, cmd: string[], opts?: { onStdout?: (chunk: string) => void }) => {
      opts?.onStdout?.(cmd[0] === "ss" ? ssOutput : "");
      return { exitCode: 0 };
    },
    status: async () => ({ status: "running" as const }),
    containerIp: async () => "127.0.0.1",
  } as unknown as VmDriver;
  const manager = new VmManager({ customDriver: driver });
  await manager.ensure("alice");
  setVmManagerForTesting(manager);

  t.after(async () => {
    setVmManagerForTesting(null);
    configurePreviewShareDir("");
    clearPreviewPortsCache();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { appPort, seen };
}

function req(
  url: string,
  init: { method?: string; headers?: Record<string, string>; user?: string | null } = {},
): NextRequest {
  const headers = new Headers(init.headers ?? {});
  if (init.user !== null && init.user !== undefined) headers.set("x-swarm-user", init.user);
  else if (init.user === undefined) headers.set("x-swarm-user", "alice");
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers,
  });
}

test("preview serve: session proxy reaches the VM app only on a detected port", async (t) => {
  const { appPort, seen } = await setup(t);
  const port = String(appPort);

  const ok = await serveSessionPreview(req(`/preview/${port}/`), { port, path: [] });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "app on /");
  // The browser's session cookie and the internal user header never reach
  // the untrusted VM app.
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers["x-swarm-user"], undefined);

  const sub = await serveSessionPreview(req(`/preview/${port}/assets/app.js`), {
    port,
    path: ["assets", "app.js"],
  });
  assert.equal(sub.status, 200);
  assert.equal(await sub.text(), "app on /assets/app.js");

  const missing = await serveSessionPreview(req("/preview/9999/"), { port: "9999", path: [] });
  assert.equal(missing.status, 404);

  const reserved = await serveSessionPreview(req("/preview/6080/"), { port: "6080", path: [] });
  assert.equal(reserved.status, 404);

  const bad = await serveSessionPreview(req("/preview/abc/"), { port: "abc", path: [] });
  assert.equal(bad.status, 404);

  const anon = await serveSessionPreview(req(`/preview/${port}/`, { user: null }), { port, path: [] });
  assert.equal(anon.status, 401);
});

test("preview serve: path traversal in the proxy path is refused", async (t) => {
  const { appPort } = await setup(t);
  const port = String(appPort);
  const traversal = await serveSessionPreview(req(`/preview/${port}/x`), {
    port,
    path: ["..", "etc"],
  });
  assert.equal(traversal.status, 404);
  const dot = await serveSessionPreview(req(`/preview/${port}/x`), { port, path: [".", "x"] });
  assert.equal(dot.status, 404);
});

test("preview serve: cross-site state-changing requests are refused", async (t) => {
  const { appPort } = await setup(t);
  const port = String(appPort);
  const cross = await serveSessionPreview(
    req(`/preview/${port}/api/save`, {
      method: "POST",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    }),
    { port, path: ["api", "save"] },
  );
  assert.equal(cross.status, 403);

  const sameSite = await serveSessionPreview(
    req(`/preview/${port}/api/save`, {
      method: "POST",
      headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
    }),
    { port, path: ["api", "save"] },
  );
  // Same-origin POST passes the gate and reaches the mock app.
  assert.equal(sameSite.status, 200);
});

test("preview serve: token proxy requires the token, the port, and a live app", async (t) => {
  const { appPort } = await setup(t);
  const port = String(appPort);
  const share = createPreviewShare("alice", appPort);

  const good = await serveSharedPreview(
    req(`/preview/share/${share.token}/${port}/`, { user: null }),
    { token: share.token, port, path: [] },
  );
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "app on /");

  const badToken = await serveSharedPreview(
    req(`/preview/share/${"a".repeat(48)}/${port}/`, { user: null }),
    { token: "a".repeat(48), port, path: [] },
  );
  assert.equal(badToken.status, 404);

  const wrongPort = await serveSharedPreview(
    req(`/preview/share/${share.token}/5173/`, { user: null }),
    { token: share.token, port: "5173", path: [] },
  );
  assert.equal(wrongPort.status, 404);

  revokePreviewShare("alice", appPort);
  const revoked = await serveSharedPreview(
    req(`/preview/share/${share.token}/${port}/`, { user: null }),
    { token: share.token, port, path: [] },
  );
  assert.equal(revoked.status, 404);
});

test("preview serve: token proxy fails closed when the app stops listening", async (t) => {
  const { appPort } = await setup(t);
  const port = String(appPort);
  const share = createPreviewShare("alice", appPort);
  // The app keeps running, but the detected set changes: simulate by
  // re-running detection after the "process" stops — the stub still reports
  // the port, so instead verify the token path is bound to the detected set
  // via a second owner whose VM reports nothing.
  const other = new VmManager({
    customDriver: {
      ensure: async (userId: string) => ({ userId, containerName: `vm-${userId}`, createdAt: 0 }),
      exec: async (_h: unknown, _c: string[], o?: { onStdout?: (c: string) => void }) => {
        o?.onStdout?.("");
        return { exitCode: 0 };
      },
      status: async () => ({ status: "missing" as const }),
      containerIp: async () => "127.0.0.1",
    } as unknown as VmDriver,
  });
  await other.ensure("alice");
  setVmManagerForTesting(other);
  clearPreviewPortsCache();
  const gone = await serveSharedPreview(
    req(`/preview/share/${share.token}/${port}/`, { user: null }),
    { token: share.token, port, path: [] },
  );
  assert.equal(gone.status, 404);
});
