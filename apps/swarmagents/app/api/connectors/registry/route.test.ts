import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { configureAuditPath } from "../../../../lib/audit";
import { CONNECTOR_CATALOG } from "../../../../lib/connectors/catalog";
import { configureLibraryStoreDir } from "../../../../lib/library/user-store";
import { libraryMcpEntries } from "../../../../lib/library/run-seed";
import { configureProviderStorePaths } from "../../../../lib/providers/store";
import { DELETE as DELETE_CUSTOM, GET as LIST_CUSTOM } from "../custom/route";
import { POST as INSTALL_REGISTRY } from "./route";

let tmpDir = "";

function req(url: string, init: { method?: string; user?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers();
  headers.set("x-swarm-user", init.user ?? "alice");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-reg-route-"));
  configureProviderStorePaths(path.join(tmpDir, "providers.json"));
  configureLibraryStoreDir(tmpDir);
  configureAuditPath(path.join(tmpDir, "audit.jsonl"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  configureLibraryStoreDir(undefined);
  configureAuditPath(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CONNECTOR_CATALOG surfaces all 40+ verified connectors from connectors.json", () => {
  assert.ok(CONNECTOR_CATALOG.length >= 40, `expected >= 40 connectors, got ${CONNECTOR_CATALOG.length}`);
  assert.ok(CONNECTOR_CATALOG.some((c) => c.id === "slack"));
  assert.ok(CONNECTOR_CATALOG.some((c) => c.id === "notion"));
  assert.ok(CONNECTOR_CATALOG.some((c) => c.id === "postgres"));
});

test("POST /api/connectors/registry installs validated stdio/http MCP and GET/DELETE /api/connectors/custom manages it", async () => {
  const badPkg = await INSTALL_REGISTRY(
    req("/api/connectors/registry", {
      method: "POST",
      body: { id: "bad", transport: "stdio", packageManager: "npx", packageName: "foo; rm -rf /" },
    }),
  );
  assert.equal(badPkg.status, 400);

  const okStdio = await INSTALL_REGISTRY(
    req("/api/connectors/registry", {
      method: "POST",
      body: {
        id: "io.modelcontextprotocol/memory",
        name: "Memory MCP",
        description: "Persistent knowledge graph memory.",
        transport: "stdio",
        packageManager: "npx",
        packageName: "@modelcontextprotocol/server-memory",
      },
    }),
  );
  assert.equal(okStdio.status, 201);

  const customRes = LIST_CUSTOM(req("/api/connectors/custom"));
  assert.equal(customRes.status, 200);
  const customBody = (await customRes.json()) as { items: Array<{ id: string; name: string }> };
  assert.equal(customBody.items.length, 1);
  assert.equal(customBody.items[0].name, "Memory MCP");

  const mcp = libraryMcpEntries("alice");
  assert.ok(`lib-${customBody.items[0].id}` in mcp);

  const delRes = DELETE_CUSTOM(req(`/api/connectors/custom?id=${encodeURIComponent(customBody.items[0].id)}`, { method: "DELETE" }));
  assert.equal(delRes.status, 200);
  const delBody = (await delRes.json()) as { removed: boolean };
  assert.equal(delBody.removed, true);
});
