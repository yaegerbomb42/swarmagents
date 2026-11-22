// Route-level tests for the token-gated VM preview proxy:
// /preview/share/<token>/<port>/[...path].
//
// The route itself is a thin 7-method delegator over
// lib/preview/serve.ts (already lib-tested); these tests prove the
// route wiring: every method reaches serveSharedPreview with the URL
// params, unknown tokens / mismatched ports 404, and a valid share
// proxies through to the live app without leaking caller headers.
// The harness mirrors lib/preview/serve.test.ts (mock app + fake VM
// driver whose `ss` output lists the mock app's port as listening).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { VmManager, setVmManagerForTesting } from "../../../../../../lib/vm/manager";
import type { VmDriver } from "../../../../../../lib/vm/types";
import { clearPreviewPortsCache } from "../../../../../../lib/preview/ports";
import {
  configurePreviewShareDir,
  createPreviewShare,
} from "../../../../../../lib/preview/tokens";
import {
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
} from "./route";

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

async function setup(t: { after: (fn: () => void | Promise<void>) => void }): Promise<{
  appPort: number;
  seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
}> {
  const { server, seen } = mockApp();
  const appPort = await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-preview-share-route-"));
  configurePreviewShareDir(dir);
  clearPreviewPortsCache();

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
  init: { method?: string; body?: string } = {},
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    ...(init.body ? { body: init.body } : {}),
  });
}

function params(token: string, port: string, path?: string[]) {
  return { params: Promise.resolve({ token, port, ...(path ? { path } : {}) }) };
}

test("preview share route: an unknown token 404s", async (t) => {
  await setup(t);
  const res = await GET(
    req("/preview/share/nope/3000/"),
    params("nope", "3000"),
  );
  assert.equal(res.status, 404);
});

test("preview share route: an invalid port 404s", async (t) => {
  await setup(t);
  const res = await GET(req("/preview/share/abc/abc/"), params("abc", "abc"));
  assert.equal(res.status, 404);
});

test("preview share route: a token for another port 404s", async (t) => {
  const { appPort } = await setup(t);
  const share = createPreviewShare("alice", appPort);
  const res = await GET(
    req(`/preview/share/${share.token}/9999/`),
    params(share.token, "9999"),
  );
  assert.equal(res.status, 404);
});

test("preview share route: a valid share proxies GET through to the app", async (t) => {
  const { appPort, seen } = await setup(t);
  const share = createPreviewShare("alice", appPort);
  const res = await GET(
    req(`/preview/share/${share.token}/${appPort}/assets/app.js`),
    params(share.token, String(appPort), ["assets", "app.js"]),
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "app on /assets/app.js");
  assert.equal(seen[0].method, "GET");
  // Caller headers never reach the untrusted VM app.
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers["x-swarm-user"], undefined);
});

test("preview share route: a valid share proxies POST with its method and path", async (t) => {
  const { appPort, seen } = await setup(t);
  const share = createPreviewShare("alice", appPort);
  const res = await POST(
    req(`/preview/share/${share.token}/${appPort}/submit`, {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    }),
    params(share.token, String(appPort), ["submit"]),
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "app on /submit");
  assert.equal(seen[0].method, "POST");
});

test("preview share route: every method delegates (unknown token 404s, never 405)", async (t) => {
  await setup(t);
  for (const handler of [PUT, PATCH, DELETE, HEAD, OPTIONS]) {
    const res = await handler(req("/preview/share/nope/3000/"), params("nope", "3000"));
    assert.equal(res.status, 404);
  }
});
