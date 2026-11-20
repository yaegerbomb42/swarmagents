import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { NextRequest } from "next/server";
import { VmManager, setVmManagerForTesting } from "../../../../lib/vm/manager";
import type { VmDriver } from "../../../../lib/vm/types";
import { clearPreviewPortsCache } from "../../../../lib/preview/ports";
import { GET } from "./route";

async function setup(t: { after: (fn: () => void | Promise<void>) => void }): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("preview app");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock app did not bind");
  const port = addr.port;
  const ssOutput = `tcp LISTEN 0 4096 0.0.0.0:${port} 0.0.0.0:*`;
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
  clearPreviewPortsCache();
  t.after(async () => {
    setVmManagerForTesting(null);
    clearPreviewPortsCache();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return port;
}

test("preview route: bare /preview/<port>/ serves the app root (optional catch-all)", async (t) => {
  const port = await setup(t);
  const req = new NextRequest(`http://localhost/preview/${port}/`, {
    headers: { "x-swarm-user": "alice" },
  });
  const res = await GET(req, { params: Promise.resolve({ port: String(port) }) });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "preview app");
  // The in-app tab iframes this response: same-origin framing must be allowed.
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'self'");
});

test("preview route: unauthenticated requests are refused", async (t) => {
  const port = await setup(t);
  const req = new NextRequest(`http://localhost/preview/${port}/`);
  const res = await GET(req, { params: Promise.resolve({ port: String(port) }) });
  assert.equal(res.status, 401);
});
