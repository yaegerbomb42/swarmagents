import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { configureAuditPath, readAuditEntries } from "../../../lib/audit";
import { configureLibraryStoreDir } from "../../../lib/library/user-store";
import { libraryAllowedToolPermissions, libraryMcpEntries } from "../../../lib/library/run-seed";
import { configureProviderStorePaths, readConfiguredProviders, saveProvider } from "../../../lib/providers/store";
import { vaultProxyEnv } from "../../../lib/secrets/inject";
import { listSecrets } from "../../../lib/secrets/registry";
import { DELETE as DELETE_CONNECTOR, GET as GET_CONNECTOR } from "./[id]/route";
import { GET as LIST_CONNECTORS, POST as CONNECT_CONNECTOR } from "./route";

let tmpDir = "";
let prevHome: string | undefined;
let prevKeysSecret: string | undefined;
let prevSessionSecret: string | undefined;
let prevServerMode: string | undefined;

function req(url: string, init: { method?: string; user?: string | null; body?: unknown } = {}): NextRequest {
  const headers = new Headers();
  const user = init.user === undefined ? "alice" : init.user;
  if (user !== null) headers.set("x-swarm-user", user);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-connectors-"));
  prevHome = process.env.SWARM_HOME;
  prevKeysSecret = process.env.SWARM_KEYS_SECRET;
  prevSessionSecret = process.env.SWARM_SESSION_SECRET;
  prevServerMode = process.env.SWARM_SERVER_MODE;
  process.env.SWARM_HOME = tmpDir;
  process.env.SWARM_KEYS_SECRET = "k".repeat(40);
  process.env.SWARM_SESSION_SECRET = "s".repeat(40);
  delete process.env.SWARM_SERVER_MODE;
  configureProviderStorePaths(path.join(tmpDir, "providers.json"));
  configureLibraryStoreDir(tmpDir);
  configureAuditPath(path.join(tmpDir, "audit.jsonl"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  configureLibraryStoreDir(undefined);
  configureAuditPath(undefined);
  if (prevHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = prevHome;
  if (prevKeysSecret === undefined) delete process.env.SWARM_KEYS_SECRET;
  else process.env.SWARM_KEYS_SECRET = prevKeysSecret;
  if (prevSessionSecret === undefined) delete process.env.SWARM_SESSION_SECRET;
  else process.env.SWARM_SESSION_SECRET = prevSessionSecret;
  if (prevServerMode === undefined) delete process.env.SWARM_SERVER_MODE;
  else process.env.SWARM_SERVER_MODE = prevServerMode;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("connector API enforces authentication in serverMode and sends Cache-Control: no-store", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  const responses = [
    LIST_CONNECTORS(req("/api/connectors", { user: null })),
    await CONNECT_CONNECTOR(req("/api/connectors", { method: "POST", user: null, body: { connectorId: "exa" } })),
    await GET_CONNECTOR(req("/api/connectors/exa", { user: null }), ctx("exa")),
    await DELETE_CONNECTOR(req("/api/connectors/exa", { method: "DELETE", user: null }), ctx("exa")),
  ];
  for (const res of responses) {
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});

test("zero-key connector (exa) connects in one click, seeds VM MCP config, and disconnects cleanly", async () => {
  const res = await CONNECT_CONNECTOR(
    req("/api/connectors", { method: "POST", body: { connectorId: "exa" } }),
  );
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { connector } = (await res.json()) as { connector: { id: string; connected: boolean; mcpInstalled: boolean } };
  assert.equal(connector.id, "exa");
  assert.equal(connector.connected, true);
  assert.equal(connector.mcpInstalled, true);

  const mcp = libraryMcpEntries("alice");
  assert.ok("lib-connector-exa" in mcp, "Exa MCP server must be seeded into agent runs");
  assert.ok(libraryAllowedToolPermissions("alice").includes("mcp__lib-connector-exa__*"));

  // Disconnecting removes the MCP item and updates connector status
  const del = await DELETE_CONNECTOR(
    req("/api/connectors/exa", { method: "DELETE" }),
    ctx("exa"),
  );
  assert.equal(del.status, 200);
  const delBody = (await del.json()) as { ok: boolean; removed: boolean; connector: { connected: boolean } };
  assert.equal(delBody.ok, true);
  assert.equal(delBody.removed, true);
  assert.equal(delBody.connector.connected, false);
  assert.deepEqual(libraryMcpEntries("alice"), {});
});

test("github connector wires providers + library MCP + secret vault without leaking credentials, and isolates users", async () => {
  const FAKE_GH = "ghp_FAKE_CONNECTOR_TOKEN_12345";
  const connectRes = await CONNECT_CONNECTOR(
    req("/api/connectors", {
      method: "POST",
      user: "alice",
      body: { connectorId: "github", inputs: { token: `Bearer ${FAKE_GH}` } },
    }),
  );
  assert.equal(connectRes.status, 201);
  const connectText = await connectRes.text();
  assert.equal(connectText.includes(FAKE_GH), false, "response must never expose plaintext token");
  const parsed = JSON.parse(connectText) as {
    connector: {
      connected: boolean;
      providerConnected: boolean;
      mcpInstalled: boolean;
      vaultConfigured: boolean;
      mask?: string;
    };
  };
  assert.equal(parsed.connector.connected, true);
  assert.equal(parsed.connector.providerConnected, true);
  assert.equal(parsed.connector.mcpInstalled, true);
  assert.equal(parsed.connector.vaultConfigured, true);
  assert.equal(parsed.connector.mask, "••••2345");

  // 1. Provider saved cleanly
  const aliceProviders = readConfiguredProviders("alice");
  assert.equal(aliceProviders.find((p) => p.id === "github")?.keys?.[0], FAKE_GH);

  // 2. MCP config gets Bearer token
  const mcp = libraryMcpEntries("alice") as Record<string, { headers?: Record<string, string> }>;
  assert.equal(mcp["lib-connector-github-read-only"]?.headers?.Authorization, `Bearer ${FAKE_GH}`);

  // 3. Vault proxy seals GitHub token & exposes GITHUB_TOKEN / GH_TOKEN placeholders
  assert.equal(listSecrets("alice").some((s) => s.id === "github"), true);
  const vaultEnv = vaultProxyEnv("alice", "run_1", "http://host.internal");
  assert.ok(vaultEnv.SWARM_VAULT_TOKEN);
  assert.equal(vaultEnv.GITHUB_TOKEN, vaultEnv.SWARM_VAULT_TOKEN);

  // 4. Audit log records connect without key material
  const auditText = fs.readFileSync(path.join(tmpDir, "audit.jsonl"), "utf8");
  assert.equal(auditText.includes(FAKE_GH), false);
  assert.ok(readAuditEntries("alice").some((e) => e.action === "connector.connect" && e.target === "github"));

  // 5. Bob sees clean disconnected state and deleting as Bob does not touch Alice
  const bobList = (await LIST_CONNECTORS(req("/api/connectors", { user: "bob" })).json()) as {
    connectors: Array<{ id: string; connected: boolean }>;
  };
  assert.equal(bobList.connectors.find((c) => c.id === "github")?.connected, false);

  const bobDel = (await (await DELETE_CONNECTOR(req("/api/connectors/github", { method: "DELETE", user: "bob" }), ctx("github"))).json()) as {
    removed: boolean;
  };
  assert.equal(bobDel.removed, false);
  assert.equal(listSecrets("alice").some((s) => s.id === "github"), true);

  // 6. Alice disconnect removes provider, MCP, and vault entry
  const aliceDel = await DELETE_CONNECTOR(req("/api/connectors/github", { method: "DELETE", user: "alice" }), ctx("github"));
  assert.equal(aliceDel.status, 200);
  const aliceDelBody = (await aliceDel.json()) as { removed: boolean; connector: { connected: boolean; providerConnected: boolean; mcpInstalled: boolean; vaultConfigured: boolean } };
  assert.equal(aliceDelBody.removed, true);
  assert.equal(aliceDelBody.connector.connected, false);
  assert.equal(aliceDelBody.connector.providerConnected, false);
  assert.equal(aliceDelBody.connector.mcpInstalled, false);
  assert.equal(aliceDelBody.connector.vaultConfigured, false);
  assert.equal(listSecrets("alice").length, 0);
  assert.deepEqual(libraryMcpEntries("alice"), {});
  assert.equal(readConfiguredProviders("alice").some((p) => p.id === "github"), false);
});

test("reuses a key already saved in Providers in one click without re-typing", async () => {
  saveProvider("alice", { id: "github", apiKey: "ghp_EXISTING_PROVIDER_9999" });

  const before = (await LIST_CONNECTORS(req("/api/connectors", { user: "alice" })).json()) as {
    connectors: Array<{
      id: string;
      connected: boolean;
      providerConnected: boolean;
      canActivateFromProvider: boolean;
      canOneClickConnect: boolean;
    }>;
  };
  const ghBefore = before.connectors.find((c) => c.id === "github")!;
  assert.equal(ghBefore.providerConnected, true);
  assert.equal(ghBefore.connected, false);
  assert.equal(ghBefore.canActivateFromProvider, true);
  assert.equal(ghBefore.canOneClickConnect, true);

  // Activate in 1 click without sending the secret back through the client
  const activated = await CONNECT_CONNECTOR(
    req("/api/connectors", { method: "POST", user: "alice", body: { connectorId: "github", useProviderKey: true } }),
  );
  assert.equal(activated.status, 201);
  const body = (await activated.json()) as { connector: { connected: boolean; mcpInstalled: boolean; vaultConfigured: boolean } };
  assert.equal(body.connector.connected, true);
  assert.equal(body.connector.mcpInstalled, true);
  assert.equal(body.connector.vaultConfigured, true);
});

test("zero-key connector (arxiv) connects in one click and seeds VM MCP config", async () => {
  const res = await CONNECT_CONNECTOR(
    req("/api/connectors", { method: "POST", body: { connectorId: "arxiv" } }),
  );
  assert.equal(res.status, 201);
  const { connector } = (await res.json()) as { connector: { id: string; connected: boolean; mcpInstalled: boolean } };
  assert.equal(connector.id, "arxiv");
  assert.equal(connector.connected, true);
  assert.equal(connector.mcpInstalled, true);

  const mcp = libraryMcpEntries("alice") as Record<string, { type?: string; command?: string; args?: string[] }>;
  const arxiv = mcp["lib-connector-arxiv"];
  assert.ok(arxiv, "arXiv MCP server must be seeded into agent runs");
  assert.equal(arxiv.type, "stdio");
  assert.equal(arxiv.command, "uvx");
  assert.ok(arxiv.args?.includes("arxiv-mcp-server"));

  const del = await DELETE_CONNECTOR(
    req("/api/connectors/arxiv", { method: "DELETE" }),
    ctx("arxiv"),
  );
  assert.equal(del.status, 200);
  assert.deepEqual(libraryMcpEntries("alice"), {});
});

test("oauth connector (notion) installs in one click with no credentials", async () => {
  const res = await CONNECT_CONNECTOR(
    req("/api/connectors", { method: "POST", body: { connectorId: "notion" } }),
  );
  assert.equal(res.status, 201);
  const { connector } = (await res.json()) as { connector: { connected: boolean; mcpInstalled: boolean } };
  assert.equal(connector.connected, true);
  assert.equal(connector.mcpInstalled, true);

  const mcp = libraryMcpEntries("alice") as Record<string, { type?: string; url?: string }>;
  const notion = mcp["lib-connector-notion"];
  assert.ok(notion, "Notion MCP server must be seeded into agent runs");
  assert.equal(notion.type, "http");
  assert.equal(notion.url, "https://mcp.notion.com/mcp");

  const del = await DELETE_CONNECTOR(
    req("/api/connectors/notion", { method: "DELETE" }),
    ctx("notion"),
  );
  assert.equal(del.status, 200);
  assert.deepEqual(libraryMcpEntries("alice"), {});
});

test("token stdio connector (postgres) seals its connection string into VM env", async () => {
  const missing = await CONNECT_CONNECTOR(
    req("/api/connectors", { method: "POST", body: { connectorId: "postgres", inputs: {} } }),
  );
  assert.equal(missing.status, 400);

  const url = "postgresql://agent:secret@db.internal:5432/app";
  const res = await CONNECT_CONNECTOR(
    req("/api/connectors", {
      method: "POST",
      body: { connectorId: "postgres", inputs: { POSTGRES_URL: url } },
    }),
  );
  assert.equal(res.status, 201);
  const text = await res.text();
  assert.equal(text.includes(url), false, "response must never expose the connection string");
  const { connector } = JSON.parse(text) as { connector: { connected: boolean; mcpInstalled: boolean } };
  assert.equal(connector.connected, true);
  assert.equal(connector.mcpInstalled, true);

  const mcp = libraryMcpEntries("alice") as Record<
    string,
    { type?: string; env?: Record<string, string>; args?: string[] }
  >;
  const pg = mcp["lib-connector-postgres"];
  assert.ok(pg, "Postgres MCP server must be seeded into agent runs");
  assert.equal(pg.type, "stdio");
  assert.equal(pg.env?.POSTGRES_URL, url);
  assert.ok(pg.args?.includes(url), "the $POSTGRES_URL arg must expand to the sealed value");

  const del = await DELETE_CONNECTOR(
    req("/api/connectors/postgres", { method: "DELETE" }),
    ctx("postgres"),
  );
  assert.equal(del.status, 200);
  assert.deepEqual(libraryMcpEntries("alice"), {});
});

test("discord connector requires bot token and config path, and seeds both", async () => {
  const noConfig = await CONNECT_CONNECTOR(
    req("/api/connectors", {
      method: "POST",
      body: { connectorId: "discord", inputs: { DISCORD_BOT_TOKEN: "Bot FAKE_TOKEN_123" } },
    }),
  );
  assert.equal(noConfig.status, 400);

  const res = await CONNECT_CONNECTOR(
    req("/api/connectors", {
      method: "POST",
      body: {
        connectorId: "discord",
        inputs: {
          DISCORD_BOT_TOKEN: "Bot FAKE_TOKEN_123",
          DISCORD_MCP_CONFIG: "/workspace/discord-mcp.json",
        },
      },
    }),
  );
  assert.equal(res.status, 201);
  const { connector } = (await res.json()) as { connector: { connected: boolean; mcpInstalled: boolean } };
  assert.equal(connector.connected, true);
  assert.equal(connector.mcpInstalled, true);

  const mcp = libraryMcpEntries("alice") as Record<
    string,
    { type?: string; env?: Record<string, string>; args?: string[] }
  >;
  const discord = mcp["lib-connector-discord"];
  assert.ok(discord, "Discord MCP server must be seeded into agent runs");
  assert.equal(discord.type, "stdio");
  assert.equal(discord.env?.DISCORD_BOT_TOKEN, "Bot FAKE_TOKEN_123");
  assert.ok(discord.args?.includes("/workspace/discord-mcp.json"));

  const del = await DELETE_CONNECTOR(
    req("/api/connectors/discord", { method: "DELETE" }),
    ctx("discord"),
  );
  assert.equal(del.status, 200);
  assert.deepEqual(libraryMcpEntries("alice"), {});
});

test("cloudflare optional accountId validates slug and sets Workers AI baseUrl; bad inputs return 400/404", async () => {
  const unknown = await CONNECT_CONNECTOR(
    req("/api/connectors", { method: "POST", body: { connectorId: "nope" } }),
  );
  assert.equal(unknown.status, 404);

  const missingSecret = await CONNECT_CONNECTOR(
    req("/api/connectors", { method: "POST", body: { connectorId: "brave-search", inputs: {} } }),
  );
  assert.equal(missingSecret.status, 400);

  const badSlug = await CONNECT_CONNECTOR(
    req("/api/connectors", {
      method: "POST",
      body: { connectorId: "cloudflare", inputs: { token: "cf_secret_1234", accountId: "../bad" } },
    }),
  );
  assert.equal(badSlug.status, 400);

  const cfOk = await CONNECT_CONNECTOR(
    req("/api/connectors", {
      method: "POST",
      body: { connectorId: "cloudflare", inputs: { token: "cf_secret_1234", accountId: "acct_abc123" } },
    }),
  );
  assert.equal(cfOk.status, 201);
  const savedCf = readConfiguredProviders("alice").find((p) => p.id === "cloudflare");
  assert.equal(savedCf?.baseUrl, "https://api.cloudflare.com/client/v4/accounts/acct_abc123/ai/v1");
});
