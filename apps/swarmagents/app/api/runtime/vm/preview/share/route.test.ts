import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { VmManager, setVmManagerForTesting } from "../../../../../../lib/vm/manager";
import type { VmDriver } from "../../../../../../lib/vm/types";
import { clearPreviewPortsCache } from "../../../../../../lib/preview/ports";
import { configurePreviewShareDir, resolvePreviewShare } from "../../../../../../lib/preview/tokens";
import { DELETE as revokeShare, GET as listShares, POST as createShare } from "./route";
import { DEFAULT_MAX_JSON_BODY_BYTES } from "../../../../../../lib/http";

const SS_SAMPLE = [
  "Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
  'tcp LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=12,fd=20))',
].join("\n");

function request(
  url: string,
  init: { method?: string; body?: string; user?: string | null } = {},
): NextRequest {
  const headers = new Headers();
  if (init.user !== null && init.user !== undefined) headers.set("x-swarm-user", init.user);
  else if (init.user === undefined) headers.set("x-swarm-user", "alice");
  if (init.body) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body ? { body: init.body } : {}),
    headers,
  });
}

async function setup(t: { after: (fn: () => void) => void }): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-preview-share-api-"));
  configurePreviewShareDir(dir);
  const driver = {
    ensure: async (userId: string) => ({ userId, containerName: `vm-${userId}`, createdAt: 0 }),
    exec: async (_handle: unknown, cmd: string[], opts?: { onStdout?: (chunk: string) => void }) => {
      opts?.onStdout?.(cmd[0] === "ss" ? SS_SAMPLE : "");
      return { exitCode: 0 };
    },
    status: async () => ({ status: "running" as const }),
    containerIp: async () => "127.0.0.1",
  } as unknown as VmDriver;
  const manager = new VmManager({ customDriver: driver });
  await manager.ensure("alice");
  setVmManagerForTesting(manager);
  clearPreviewPortsCache();
  t.after(() => {
    setVmManagerForTesting(null);
    configurePreviewShareDir("");
    clearPreviewPortsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("preview share API: create, list, revoke — owner only, listening ports only", async (t) => {
  await setup(t);
  assert.equal((await createShare(request("/api/runtime/vm/preview/share", { method: "POST", body: JSON.stringify({ port: 3000 }), user: null }))).status, 401);

  const created = await createShare(
    request("/api/runtime/vm/preview/share", { method: "POST", body: JSON.stringify({ port: 3000 }) }),
  );
  assert.equal(created.status, 200);
  const { share } = (await created.json()) as { share: { token: string; url: string; port: number } };
  assert.equal(share.port, 3000);
  assert.equal(share.url, `/preview/share/${share.token}/3000/`);
  assert.equal(resolvePreviewShare(share.token)?.ownerId, "alice");

  // A port nothing listens on cannot be shared.
  const unlistened = await createShare(
    request("/api/runtime/vm/preview/share", { method: "POST", body: JSON.stringify({ port: 9999 }) }),
  );
  assert.equal(unlistened.status, 404);

  const bad = await createShare(
    request("/api/runtime/vm/preview/share", { method: "POST", body: JSON.stringify({ port: "x" }) }),
  );
  assert.equal(bad.status, 400);

  const listed = await listShares(request("/api/runtime/vm/preview/share"));
  assert.equal(listed.status, 200);
  const { shares } = (await listed.json()) as { shares: Array<{ port: number; url: string }> };
  assert.equal(shares.length, 1);
  assert.equal(shares[0].port, 3000);

  const revoked = await revokeShare(request("/api/runtime/vm/preview/share?port=3000", { method: "DELETE" }));
  assert.equal(revoked.status, 200);
  assert.equal(((await revoked.json()) as { revoked: boolean }).revoked, true);
  assert.equal(resolvePreviewShare(share.token), null);

  const again = await revokeShare(request("/api/runtime/vm/preview/share?port=3000", { method: "DELETE" }));
  assert.equal(((await again.json()) as { revoked: boolean }).revoked, false);
});

test("preview share POST rejects an oversized body with 413", async (t) => {
  await setup(t);
  const huge = JSON.stringify({
    port: 3000,
    padding: "x".repeat(DEFAULT_MAX_JSON_BODY_BYTES + 1024),
  });
  const res = await createShare(
    request("/api/runtime/vm/preview/share", { method: "POST", body: huge }),
  );
  assert.equal(res.status, 413);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /too large/i);
});

test("preview share POST treats a malformed body as a missing port (400)", async (t) => {
  await setup(t);
  const res = await createShare(
    request("/api/runtime/vm/preview/share", { method: "POST", body: "{not json" }),
  );
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error?: string };
  assert.equal(data.error, "A valid port is required.");
});
