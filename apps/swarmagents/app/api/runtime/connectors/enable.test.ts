/**
 * Route tests for POST /api/runtime/connectors/<runToken>/enable:
 * 401 on bad/expired tokens, 403 on keyed connectors, and successful
 * zero-key activation returning connector + mcpEntries.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./[runToken]/enable/route";
import { clearRevokedRunTokens, signRunToken } from "../../../../lib/runtime/run-token";
import { configureProviderStorePaths } from "../../../../lib/providers/store";
import { configureLibraryStoreDir } from "../../../../lib/library/user-store";

const ENV: Record<string, string | undefined> = { SWARM_SESSION_SECRET: "connector-enable-secret" };
const USER = "local_user@example.com";

let tempDir: string;
let savedHome: string | undefined;

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/runtime/connectors/tok/enable", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(token: string) {
  return { params: Promise.resolve({ runToken: token }) };
}

test.before(() => {
  process.env.SWARM_SESSION_SECRET = "connector-enable-secret";
});

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-connector-enable-"));
  savedHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = tempDir;
  configureProviderStorePaths(join(tempDir, "providers.json"));
  configureLibraryStoreDir(join(tempDir, "library"));
});

test.afterEach(() => {
  clearRevokedRunTokens();
  configureLibraryStoreDir(undefined);
  configureProviderStorePaths("");
  if (savedHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = savedHome;
  rmSync(tempDir, { recursive: true, force: true });
});

test("rejects invalid or expired run token with 401", async () => {
  const res = await POST(makeReq({ connectorId: "exa" }), ctx("rt1.bad.token"));
  assert.equal(res.status, 401);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /invalid|expired/i);
});

test("rejects keyed connectors with 403", async () => {
  const token = signRunToken(USER, "run_1", { env: ENV });
  const res = await POST(makeReq({ connectorId: "github" }), ctx(token));
  assert.equal(res.status, 403);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "Keyed connectors must be configured by the user in /connectors.");
});

test("activates a zero-key connector and returns mcpEntries", async () => {
  const token = signRunToken(USER, "run_1", { env: ENV });
  const res = await POST(makeReq({ connectorId: "exa" }), ctx(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    connector: { id: string; connected: boolean };
    mcpEntries: Record<string, unknown>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.connector.id, "exa");
  assert.equal(body.connector.connected, true);
  assert.equal(typeof body.mcpEntries, "object");
  assert.ok(Object.keys(body.mcpEntries).length > 0);
});
