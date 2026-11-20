import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GET as connectorsGET, POST as connectorsPOST } from "../../app/api/library/connectors/route";
import { GET as itemsGET, POST as itemsPOST } from "../../app/api/library/items/route";
import { GET as providersGET, POST as providersPOST } from "../../app/api/providers/route";
import { USER_HEADER } from "../auth";
import { CONNECTORS } from "../library/catalog";
import { LIBRARY_KINDS } from "../library/types";
import { libraryMcpEntries, libraryServerName, librarySkillSeedFiles, libraryToolSeedFiles } from "../library/run-seed";
import { configureLibraryStoreDir, listInstalledItems, userLibraryFilePath } from "../library/user-store";
import { configureProviderStorePaths } from "../providers/store";
import { LibraryApiError } from "./library";
import { addSwarmCatalogEntry, buildSwarmCatalog, filterSwarmCatalog, loadSwarmCatalog, PROVIDER_SETTINGS_URL } from "./swarm-catalog";

const OWNER = "catalog-alice";

function useAccountRoutes(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "swarm-capability-catalog-"));
  configureLibraryStoreDir(dir);
  configureProviderStorePaths(path.join(dir, "providers.json"));
  t.after(() => {
    configureLibraryStoreDir(undefined);
    configureProviderStorePaths("");
    rmSync(dir, { recursive: true, force: true });
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set(USER_HEADER, OWNER);
    const request = new Request(new URL(url, "http://localhost"), { ...init, headers });
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/library/connectors") return request.method === "POST" ? connectorsPOST(request) : connectorsGET(request);
    if (pathname === "/api/library/items") return request.method === "POST" ? itemsPOST(request) : itemsGET(request);
    if (pathname === "/api/providers") {
      return request.method === "POST" ? providersPOST(request) : providersGET(request);
    }
    throw new Error(`Unexpected request: ${request.method} ${pathname}`);
  });
  return { dir, fetchMock };
}

function find<T extends { id: string }>(entries: readonly T[], id: string): T {
  const entry = entries.find((row) => row.id === id);
  assert.ok(entry, `Expected ${id} in the catalog`);
  return entry;
}

const verifiedConnectors = CONNECTORS.map((entry) => ({ ...entry, canInstall: true }));

test("the curated catalog has real sources and all four kinds, without OAuth-only or retired entries", () => {
  const entries = buildSwarmCatalog(verifiedConnectors, [], []);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.deepEqual(new Set(entries.map((entry) => entry.kind)), new Set(LIBRARY_KINDS));
  for (const entry of entries) {
    assert.equal(new URL(entry.sourceUrl).protocol, "https:");
    assert.ok(entry.vendor && entry.description && entry.setup && entry.unlocks);
  }
  for (const id of ["github", "slack", "google-drive", "puppeteer", "playwright", "postgres", "sqlite", "filesystem"]) {
    assert.ok(!entries.some((entry) => entry.id === `connector:${id}`), `${id} must not offer a misleading Add`);
  }
  const exa = find(verifiedConnectors, "exa");
  for (const invalid of [
    { ...exa, verified: false },
    { ...exa, canInstall: false },
    { ...exa, sourceUrl: undefined },
    { ...exa, auth: "oauth" },
  ]) {
    assert.ok(!buildSwarmCatalog([invalid], [], []).some((entry) => entry.id === "connector:exa"));
  }
});

test("search terms match provider and capabilities and combine with both filters", () => {
  const entries = buildSwarmCatalog(verifiedConnectors, [], []);
  assert.deepEqual(filterSwarmCatalog(entries, "  BYTEBASE  schema ", "mcp", "data").map((row) => row.id), ["connector:postgres-dbhub"]);
  assert.deepEqual(filterSwarmCatalog(entries, "anthropic  report", "skill", "comms").map((row) => row.id), ["skill:internal-comms"]);
  assert.deepEqual(filterSwarmCatalog(entries, "bytebase schema", "connector", "data"), []);
  assert.deepEqual(filterSwarmCatalog(entries, "", "mcp", "files"), []);
  assert.equal(filterSwarmCatalog(entries, " ", "all", "all").length, entries.length);
});

test("provider rows reflect the real per-account store and direct missing keys to Provider Settings", async (t) => {
  const { fetchMock } = useAccountRoutes(t);
  const entry = find(await loadSwarmCatalog(), "provider:xai");
  assert.equal(entry.add.via, "provider-settings");
  assert.equal(PROVIDER_SETTINGS_URL, "/providers");
  assert.equal(entry.installed, false);
  fetchMock.mock.resetCalls();
  await assert.rejects(addSwarmCatalogEntry(entry), /Provider Settings/);
  assert.equal(fetchMock.mock.callCount(), 0, "the catalog does not submit a blank or fake key");

  // This is the existing settings endpoint, not a new catalog mutation.
  const saved = await fetch("/api/providers", { method: "POST", body: JSON.stringify({ id: "xai", apiKey: "fixture-not-a-real-key" }) });
  assert.equal(saved.status, 201);
  assert.ok(!(await saved.text()).includes("fixture-not-a-real-key"));
  assert.equal(find(await loadSwarmCatalog(), "provider:xai").installed, true);
});

test("connector and MCP adds persist to one account and feed the existing runtime MCP config", async (t) => {
  useAccountRoutes(t);
  const entries = await loadSwarmCatalog();
  const fakeToken = "fixture-not-a-real-token";
  const dsn = "postgresql://readonly:fixture@db.example.test/database";
  const inputs: Record<string, Record<string, string>> = {
    "connector:github-read-only": { Authorization: `Bearer ${fakeToken}` },
    "connector:brave-search": { BRAVE_API_KEY: "fixture-not-a-real-key" },
    "connector:postgres-dbhub": { DSN: dsn },
  };
  for (const row of entries.filter((item) => item.add.via === "connector")) {
    assert.equal(row.installed, false);
    const added = await addSwarmCatalogEntry(row, inputs[row.id]);
    assert.equal(added.kind, "connector");
    assert.ok(added.secretFields.every((field) => field.configured));
    assert.ok(!JSON.stringify(added).includes(fakeToken));
    assert.ok(!JSON.stringify(added).includes(dsn));
  }

  const mcp = libraryMcpEntries(OWNER);
  assert.deepEqual(mcp["lib-connector-github-read-only"], {
    type: "http", url: "https://api.githubcopilot.com/mcp/readonly", headers: { Authorization: `Bearer ${fakeToken}` },
  });
  assert.deepEqual(mcp["lib-connector-postgres-dbhub"], {
    type: "stdio", command: "npx", args: ["-y", "@bytebase/dbhub@2.0.0", "--transport", "stdio"], env: { DSN: dsn },
  });
  assert.deepEqual(mcp["lib-connector-openai-docs"], { type: "http", url: "https://developers.openai.com/mcp" });
  const stored = readFileSync(userLibraryFilePath(OWNER), "utf8");
  assert.ok(!stored.includes(fakeToken));
  assert.ok(!stored.includes(dsn));
  assert.deepEqual(libraryMcpEntries("another-account"), {});
  const refreshed = await loadSwarmCatalog();
  const installed = refreshed.filter((entry) => entry.add.via === "connector" && entry.installed);
  assert.equal(installed.length, Object.keys(mcp).length);
  await assert.rejects(addSwarmCatalogEntry(find(refreshed, "connector:exa")), /already added/i);
});

test("missing keys, malformed token/DSN and offline loads fail without creating an item", async (t) => {
  const { fetchMock } = useAccountRoutes(t);
  const entries = await loadSwarmCatalog();
  fetchMock.mock.resetCalls();
  await assert.rejects(addSwarmCatalogEntry(find(entries, "connector:brave-search")), /API key is required/);
  await assert.rejects(addSwarmCatalogEntry(find(entries, "connector:github-read-only"), { Authorization: "not a token" }), /without spaces/);
  await assert.rejects(addSwarmCatalogEntry(find(entries, "connector:postgres-dbhub"), { DSN: "sqlite:///test.db" }), /connection string/);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(listInstalledItems(OWNER), []);
  fetchMock.mock.mockImplementation(async () => { throw new TypeError("Network unavailable"); });
  await assert.rejects(loadSwarmCatalog(), /Network unavailable/);
  fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ error: "Library temporarily unavailable." }), { status: 503 }));
  await assert.rejects(addSwarmCatalogEntry(find(entries, "connector:exa")), (error) => error instanceof LibraryApiError && error.status === 503);
  fetchMock.mock.mockImplementation(async () => Response.json({}));
  await assert.rejects(addSwarmCatalogEntry(find(entries, "connector:exa")), /Invalid library install response/);
});

test("bundled skills install their pinned content and license; the tool executes through the seeded MCP server", async (t) => {
  const { dir } = useAccountRoutes(t);
  const entries = await loadSwarmCatalog();
  for (const skill of filterSwarmCatalog(entries, "", "skill", "all")) {
    const item = await addSwarmCatalogEntry(skill);
    const files = librarySkillSeedFiles(OWNER).filter((file) => file.path.includes(`/${libraryServerName(item.id)}/`));
    assert.ok(files.some((file) => file.path.endsWith("/SKILL.md") && file.content.startsWith("---\nname:")));
    assert.ok(files.some((file) => file.path.endsWith("/LICENSE.txt") && file.content.includes("Apache License")));
    if (skill.id === "skill:internal-comms") assert.equal(files.filter((file) => file.path.includes("/examples/")).length, 4);
  }
  const formatter = await addSwarmCatalogEntry(find(entries, "tool:format-json"));
  const refreshed = await loadSwarmCatalog();
  assert.ok(refreshed.filter((row) => row.kind === "skill" || row.kind === "tool").every((row) => row.installed));

  for (const file of libraryToolSeedFiles(OWNER)) writeFileSync(path.join(dir, path.basename(file.path)), file.content);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(dir, "library-tools-server.mjs")],
    env: { SWARM_LIBRARY_TOOLS: path.join(dir, "library-tools.json") },
  });
  const client = new Client({ name: "catalog-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const name = formatter.id.replace(/-/g, "_");
    const tools = await client.listTools();
    assert.equal(tools.tools[0].name, name);
    assert.deepEqual(tools.tools[0].inputSchema.required, ["text"]);
    for (const [text, expected] of [["{\"ready\":true}", { formatted: "{\n  \"ready\": true\n}" }], ["not json", { error: "The input is not valid JSON." }]] as const) {
      const result = await client.callTool({ name, arguments: { text } });
      assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(expected) }]);
    }
  } finally {
    await client.close();
  }
});
