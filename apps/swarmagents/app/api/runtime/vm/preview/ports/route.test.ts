import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { VmManager, setVmManagerForTesting } from "../../../../../../lib/vm/manager";
import type { VmDriver } from "../../../../../../lib/vm/types";
import { clearPreviewPortsCache } from "../../../../../../lib/preview/ports";
import { GET as listPorts, POST as refreshPorts } from "./route";

const SS_SAMPLE = [
  "Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
  'tcp LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=12,fd=20))',
  'tcp LISTEN 0 4096 [::]:5173 [::]:* users:(("node",pid=15,fd=21))',
].join("\n");

function request(url: string, init: { method?: string; user?: string | null } = {}): NextRequest {
  const headers = new Headers();
  if (init.user !== null && init.user !== undefined) headers.set("x-swarm-user", init.user);
  else if (init.user === undefined) headers.set("x-swarm-user", "alice");
  return new NextRequest(`http://localhost${url}`, {
    ...(init.method ? { method: init.method } : {}),
    headers,
  });
}

async function setupManager(t: { after: (fn: () => void) => void }, running = true): Promise<void> {
  const driver = {
    ensure: async (userId: string) => ({ userId, containerName: `vm-${userId}`, createdAt: 0 }),
    exec: async (_handle: unknown, cmd: string[], opts?: { onStdout?: (chunk: string) => void }) => {
      opts?.onStdout?.(cmd[0] === "ss" ? SS_SAMPLE : "");
      return { exitCode: 0 };
    },
    status: async () => ({ status: running ? "running" : "missing" }),
    containerIp: async () => "127.0.0.1",
  } as unknown as VmDriver;
  const manager = new VmManager({ customDriver: driver });
  await manager.ensure("alice");
  setVmManagerForTesting(manager);
  clearPreviewPortsCache();
  t.after(() => {
    setVmManagerForTesting(null);
    clearPreviewPortsCache();
  });
}

test("preview ports API: lists detected ports, 401 without a session", async (t) => {
  await setupManager(t);
  assert.equal((await listPorts(request("/api/runtime/vm/preview/ports", { user: null }))).status, 401);

  const res = await listPorts(request("/api/runtime/vm/preview/ports"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { running: boolean; ports: number[]; cached: boolean };
  assert.equal(body.running, true);
  assert.deepEqual(body.ports, [3000, 5173]);
  assert.equal(body.cached, false);

  const again = await listPorts(request("/api/runtime/vm/preview/ports"));
  assert.equal(((await again.json()) as { cached: boolean }).cached, true);

  const forced = await refreshPorts(request("/api/runtime/vm/preview/ports", { method: "POST" }));
  assert.equal(forced.status, 200);
  assert.equal(((await forced.json()) as { cached: boolean }).cached, false);
  assert.equal((await refreshPorts(request("/api/runtime/vm/preview/ports", { method: "POST", user: null }))).status, 401);
});

test("preview ports API: a hibernated VM reports no ports without waking", async (t) => {
  await setupManager(t, false);
  const res = await listPorts(request("/api/runtime/vm/preview/ports"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { running: boolean; ports: number[] };
  assert.equal(body.running, false);
  assert.deepEqual(body.ports, []);
});
