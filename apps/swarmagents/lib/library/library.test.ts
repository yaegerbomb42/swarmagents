/**
 * Public Library: publish -> visible to another account -> install a copy ->
 * the installer's run can use it; secrets stay with the publisher; reports
 * and admin-only unpublish; version notifications without auto-update.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLibraryStoreDir, addInstalledItem, installedItemSecrets, getStoredItem, listInstalledItems, userLibraryFilePath } from "./user-store";
import { connectorById, connectorPayload } from "./catalog";
import {
  findPublicItem,
  listPublicItems,
  publicCatalogFilePath,
  publishItem,
} from "./public-store";
import { installPublicItem, reportPublicItem, unpublishPublicItem } from "./public-store";
import { resetPublishRateLimit, publishLimitPerHour } from "./rate";
import { libraryAllowedToolPermissions, libraryMcpEntries, librarySeedFiles, libraryServerName } from "./run-seed";
import { GET as publicGET, POST as publicPOST } from "../../app/api/library/public/route";
import { GET as detailGET } from "../../app/api/library/public/[id]/route";
import { POST as installPOST } from "../../app/api/library/public/[id]/install/route";
import { POST as reportPOST } from "../../app/api/library/public/[id]/report/route";
import { POST as unpublishPOST } from "../../app/api/library/public/[id]/unpublish/route";
import { POST as versionsPOST } from "../../app/api/library/public/[id]/versions/route";
import { GET as itemsGET, POST as itemsPOST } from "../../app/api/library/items/route";
import { GET as connectorsGET, POST as connectorsPOST } from "../../app/api/library/connectors/route";
import { GET as meGET } from "../../app/api/library/me/route";

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-public-library-"));
  configureLibraryStoreDir(dir);
  savedEnv = { ...process.env };
  process.env.SWARM_LIBRARY_PUBLISH_PER_HOUR = "1000";
  delete process.env.SWARM_ADMIN_USERS;
  delete process.env.SWARM_SERVER_MODE;
  resetPublishRateLimit();
});

test.afterEach(() => {
  configureLibraryStoreDir(undefined);
  resetPublishRateLimit();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
});

function skillPayload(markdown: string, requiredFields: Array<{ key: string; label: string }> = []) {
  return { kind: "skill", skillMd: markdown, files: [], requiredFields };
}

function toolPayload(code = "return { ok: true };", requiredFields: Array<{ key: string; label: string }> = []) {
  return {
    kind: "tool",
    language: "javascript",
    code,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    requiredFields,
    timeoutMs: 5000,
  };
}

function request(body: unknown, user: string, url = "http://localhost/api/library/public"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-swarm-user": user },
    body: JSON.stringify(body),
  });
}

function get(user: string, url: string): Request {
  return new Request(url, { headers: { "x-swarm-user": user } });
}

/** Every file under `root`, concatenated (for "secret is not on disk in clear" checks). */
function readAllFiles(root: string): string {
  if (!fs.existsSync(root)) return "";
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(readAllFiles(full));
    else if (entry.isFile()) out.push(fs.readFileSync(full, "utf-8"));
  }
  return out.join("\n");
}

async function json(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

async function publishAs(user: string, body: Record<string, unknown>): Promise<{ status: number; item: any }> {
  const res = await publicPOST(request(body, user));
  return { status: res.status, item: (await json(res)).item };
}

// ---- publish / browse -------------------------------------------------------

test("publish appears for another account with an author handle and unreviewed label", async () => {
  const published = await publishAs("local_alice@example.com", {
    kind: "skill",
    name: "Deploy helper",
    description: "Ship safely",
    license: "MIT",
    payload: skillPayload("# Deploy\n\nRun the checks."),
  });
  assert.equal(published.status, 201);
  assert.equal(published.item.moderation, "unreviewed");
  assert.equal(published.item.authorHandle, "alice");
  assert.equal(published.item.version, 1);
  assert.equal(published.item.payload.skillMd, "# Deploy\n\nRun the checks.");

  const res = await publicGET(get("local_bob@example.com", "http://localhost/api/library/public"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.total, 1);
  assert.equal(body.items[0].name, "Deploy helper");
  assert.equal(body.items[0].authorHandle, "alice");
  assert.equal(body.items[0].moderation, "unreviewed");
  assert.equal(body.items[0].version, 1);
  assert.equal(body.items[0].license, "MIT");
  // The public listing must not carry the publisher's user id.
  assert.equal(JSON.stringify(body).includes("local_alice@example.com"), false);
});

test("browse search, kind filter and sort by installs/newest", async () => {
  await publishAs("alice", { kind: "skill", name: "Alpha skill", payload: skillPayload("# Alpha") });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const beta = await publishAs("alice", { kind: "tool", name: "Beta tool", payload: toolPayload() });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await publishAs("alice", { kind: "skill", name: "Gamma skill", payload: skillPayload("# Gamma") });

  const toolRes = await publicGET(get("bob", "http://localhost/api/library/public?kind=tool"));
  const toolBody = await json(toolRes);
  assert.equal(toolBody.items.length, 1);
  assert.equal(toolBody.items[0].name, "Beta tool");

  const searchRes = await publicGET(get("bob", "http://localhost/api/library/public?q=gamma"));
  assert.deepEqual((await json(searchRes)).items.map((item: any) => item.name), ["Gamma skill"]);

  // Give Beta a unique install, then installs-sort puts it first.
  const betaId = (await json(await detailGET(get("bob", `http://localhost/api/library/public/${beta.item.id}`), { params: Promise.resolve({ id: beta.item.id }) }))).item.id;
  await installPOST(request({}, "carol", `http://localhost/api/library/public/${betaId}/install`), {
    params: Promise.resolve({ id: betaId }),
  });
  const sorted = await publicGET(get("bob", "http://localhost/api/library/public?sort=installs"));
  assert.equal((await json(sorted)).items[0].name, "Beta tool");

  const newest = await publicGET(get("bob", "http://localhost/api/library/public?sort=newest"));
  assert.deepEqual((await json(newest)).items.map((item: any) => item.name), ["Gamma skill", "Beta tool", "Alpha skill"]);
});

// ---- install is a copy, not a live link ------------------------------------

test("install copies the current version and version bumps only notify", async () => {
  const published = await publishAs("alice", {
    kind: "skill",
    name: "Copied skill",
    license: "Apache-2.0",
    payload: skillPayload("# version one"),
  });
  const publicId: string = published.item.id;

  const first = await installPOST(request({}, "bob", `http://localhost/api/library/public/${publicId}/install`), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(first.status, 201);
  const firstBody = await json(first);
  assert.equal(firstBody.item.payload.kind, "skill");
  assert.equal((firstBody.item.payload as any).skillMd, "# version one");
  assert.equal(firstBody.item.sourcePublicId, publicId);
  assert.equal(firstBody.item.version, 1);

  // Publisher ships v2.
  const bumped = await versionsPOST(
    request({ payload: skillPayload("# version two"), changelog: "fix" }, "alice"),
    { params: Promise.resolve({ id: publicId }) },
  );
  assert.equal(bumped.status, 201);
  assert.equal((await json(bumped)).item.version, 2);

  // Bob's installed copy is still v1 and flagged, not changed.
  const list = await json(await itemsGET(get("bob", "http://localhost/api/library/items")));
  const bobItem = list.items.find((item: any) => item.sourcePublicId === publicId);
  assert.equal(bobItem.version, 1);
  assert.equal((bobItem.payload as any).skillMd, "# version one", "installed code must not auto-update");
  assert.equal(bobItem.updateAvailable, true);
  assert.equal(bobItem.latestVersion, 2);
  assert.equal(list.notifications[0].fromVersion, 1);
  assert.equal(list.notifications[0].toVersion, 2);

  // Re-installing is the explicit update.
  const second = await installPOST(request({}, "bob", `http://localhost/api/library/public/${publicId}/install`), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(second.status, 201);
  assert.equal((await json(second)).item.version, 2);
  const after = await json(await itemsGET(get("bob", "http://localhost/api/library/items")));
  assert.equal(after.items[0].version, 2);
  assert.equal(after.items[0].updateAvailable, false);

  // Unique install count only (bob installed twice).
  const record = findPublicItem(publicId)!;
  assert.equal(record.installs, 1);
  assert.equal(record.installerIds.length, 1);
});

test("install requires the installer's own values for required fields", async () => {
  const published = await publishAs("alice", {
    kind: "tool",
    name: "API caller",
    payload: toolPayload("return { token: process.env.TOKEN };", [{ key: "TOKEN", label: "API token" }]),
  });
  const publicId: string = published.item.id;

  const missing = await installPOST(request({}, "bob", `http://localhost/api/library/public/${publicId}/install`), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(missing.status, 400);
  assert.deepEqual((await json(missing)).missingFields, ["TOKEN"]);

  const ok = await installPOST(
    request({ secrets: { TOKEN: "bob-own-token" } }, "bob", `http://localhost/api/library/public/${publicId}/install`),
    { params: Promise.resolve({ id: publicId }) },
  );
  assert.equal(ok.status, 201);
  const body = await json(ok);
  assert.equal(body.item.secretFields[0].configured, true);
  assert.match(body.item.secretFields[0].mask, /oken$/);
  assert.equal(JSON.stringify(body).includes("bob-own-token"), false);
});

// ---- secrets never leave the publisher -------------------------------------

test("publishing a local tool never copies its secret value to the catalog or installer", async () => {
  // Alice's own tool, with a value sealed in her account.
  const local = addInstalledItem("local_alice@example.com", {
    kind: "tool",
    name: "Private tool",
    description: "Uses a private key",
    payload: toolPayload("return process.env.PRIVATE_KEY;", [{ key: "PRIVATE_KEY", label: "Private key" }]),
    secrets: { PRIVATE_KEY: "alice-super-secret-value-1234" },
  });

  const aliceFile = path.join(dir, "users");
  const rawFiles = readAllFiles(aliceFile);
  assert.equal(rawFiles.includes("alice-super-secret-value-1234"), false, "secret must be encrypted at rest");

  // Publishing from the library copies payload + field names only.
  const published = await publishAs("local_alice@example.com", { sourceItemId: local.id });
  assert.equal(published.status, 201);
  const publicId: string = published.item.id;
  const catalogRaw = fs.readFileSync(publicCatalogFilePath(), "utf-8");
  assert.equal(catalogRaw.includes("alice-super-secret-value-1234"), false);
  assert.equal(JSON.stringify(published.item).includes("alice-super-secret-value-1234"), false);
  assert.deepEqual(published.item.requiredFields, [{ key: "PRIVATE_KEY", label: "Private key" }]);

  // An explicit secrets object in the publish body is rejected.
  const rejected = await publicPOST(
    request({ kind: "tool", name: "Leaky", payload: toolPayload(), secrets: { X: "nope" } }, "alice"),
  );
  assert.equal(rejected.status, 400);

  // Bob installs with his own value; Alice's value cannot appear.
  const installed = await installPOST(
    request({ secrets: { PRIVATE_KEY: "bob-own-secret-9876" } }, "bob", `http://localhost/api/library/public/${publicId}/install`),
    { params: Promise.resolve({ id: publicId }) },
  );
  assert.equal(installed.status, 201);
  const stored = getStoredItem("bob", (await json(installed)).item.id)!;
  assert.deepEqual(installedItemSecrets("bob", stored), { PRIVATE_KEY: "bob-own-secret-9876" });
  assert.equal(readAllFiles(path.join(dir, "users")).includes("bob-own-secret-9876"), false);
});

// ---- moderation -------------------------------------------------------------

test("reports are counted and only an admin can unpublish another account's item", async () => {
  const published = await publishAs("alice", { kind: "skill", name: "Suspicious", payload: skillPayload("# Suspicious") });
  const publicId: string = published.item.id;

  const reported = await reportPOST(request({ reason: "Looks unsafe" }, "bob"), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(reported.status, 201);
  assert.equal((await json(reported)).reportCount, 1);
  const listed = await json(await publicGET(get("carol", "http://localhost/api/library/public")));
  assert.equal(listed.items[0].reported, true);
  assert.equal(listed.items[0].moderation, "unreviewed");

  const denied = await unpublishPOST(request({}, "bob"), { params: Promise.resolve({ id: publicId }) });
  assert.equal(denied.status, 403);

  process.env.SWARM_ADMIN_USERS = "admin@swarm.test";
  const allowed = await unpublishPOST(request({}, "local_admin@swarm.test"), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(allowed.status, 200);
  assert.equal((await json(allowed)).item.moderation, "unpublished");

  // Gone from browse and from other users' detail views; the owner and an
  // admin can still see what happened.
  const browse = await json(await publicGET(get("carol", "http://localhost/api/library/public")));
  assert.equal(browse.total, 0);
  const hidden = await detailGET(get("carol", `http://localhost/api/library/public/${publicId}`), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(hidden.status, 404);
  const adminView = await detailGET(get("local_admin@swarm.test", `http://localhost/api/library/public/${publicId}`), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(adminView.status, 200);
  assert.equal((await json(adminView)).item.moderation, "unpublished");
  // An unpublished item cannot be installed.
  const install = await installPOST(request({}, "carol", `http://localhost/api/library/public/${publicId}/install`), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(install.status, 404);
});

test("only the publisher can publish a new version", async () => {
  const published = await publishAs("alice", { kind: "skill", name: "Mine", payload: skillPayload("# v1") });
  const publicId: string = published.item.id;
  const denied = await versionsPOST(request({ payload: skillPayload("# v2") }, "bob"), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(denied.status, 403);
  const allowed = await versionsPOST(request({ payload: skillPayload("# v2") }, "alice"), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.equal(allowed.status, 201);
});

test("publishing is rate limited per account", async () => {
  process.env.SWARM_LIBRARY_PUBLISH_PER_HOUR = "2";
  resetPublishRateLimit();
  assert.equal(publishLimitPerHour(), 2);
  assert.equal((await publishAs("alice", { kind: "skill", name: "One", payload: skillPayload("#1") })).status, 201);
  assert.equal((await publishAs("alice", { kind: "skill", name: "Two", payload: skillPayload("#2") })).status, 201);
  const limited = await publicPOST(request({ kind: "skill", name: "Three", payload: skillPayload("#3") }, "alice"));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  // A different account has its own budget.
  assert.equal((await publishAs("bob", { kind: "skill", name: "Bobs", payload: skillPayload("#b") })).status, 201);
});

// ---- account API / connectors ---------------------------------------------

test("connectors can be catalogued and added to the caller's library", async () => {
  const catalog = await json(await connectorsGET(get("bob", "http://localhost/api/library/connectors")));
  assert.ok(catalog.connectors.length >= 30);
  const github = catalog.connectors.find((entry: any) => entry.id === "github");
  assert.ok(github);
  assert.equal(github.canInstall, true);

  const added = await connectorsPOST(request({ connectorId: "github" }, "bob"));
  assert.equal(added.status, 201);
  const item = (await json(added)).item;
  assert.equal(item.kind, "connector");
  assert.equal(item.payload.transport, "http");

  const list = await json(await itemsGET(get("bob", "http://localhost/api/library/items")));
  assert.ok(list.items.some((entry: any) => entry.kind === "connector"));
  // Another account does not see it.
  const other = await json(await itemsGET(get("carol", "http://localhost/api/library/items")));
  assert.equal(other.items.length, 0);

  const me = await json(await meGET(get("bob", "http://localhost/api/library/me")));
  assert.equal(me.user, "bob");
  assert.equal(me.publishLimitPerHour, 1000);
});

test("adding a tool with a secret never returns the value", async () => {
  const res = await itemsPOST(
    request(
      {
        kind: "tool",
        name: "Secretive",
        payload: toolPayload("return 1;", [{ key: "TOKEN", label: "Token" }]),
        secrets: { TOKEN: "plain-value-4321" },
      },
      "bob",
    ),
  );
  assert.equal(res.status, 201);
  const text = await res.text();
  assert.equal(text.includes("plain-value-4321"), false);
  assert.equal(JSON.parse(text).item.secretFields[0].configured, true);
});

// ---- runtime seeding --------------------------------------------------------

test("installed skills/tools/MCP servers are seeded into the account's VM config", async () => {
  const skill = addInstalledItem("bob", {
    kind: "skill",
    name: "Runbook",
    description: "Ops runbook",
    payload: { kind: "skill", skillMd: "# Runbook\n\nDo the thing.", files: [{ path: "scripts/check.sh", content: "echo ok" }], requiredFields: [] },
  });
  const tool = addInstalledItem("bob", {
    kind: "tool",
    name: "Counter",
    description: "Counts",
    payload: toolPayload("return { n: args.n };", [{ key: "TOOL_TOKEN", label: "Token" }]),
    secrets: { TOOL_TOKEN: "tool-secret" },
  });

  const publicMcp = await publishAs("alice", {
    kind: "mcp",
    name: "Remote server",
    payload: { transport: "http", url: "https://mcp.example.test/mcp", requiredFields: [{ key: "API_KEY", label: "Key" }] },
  });
  const installedMcp = await installPOST(
    request({ secrets: { API_KEY: "mcp-secret" } }, "bob", `http://localhost/api/library/public/${publicMcp.item.id}/install`),
    { params: Promise.resolve({ id: publicMcp.item.id }) },
  );
  assert.equal(installedMcp.status, 201);

  const files = librarySeedFiles("bob");
  const skillFile = files.find((file) => file.path === `/workspace/.claude/skills/${libraryServerName(skill.id)}/SKILL.md`);
  assert.ok(skillFile, "SKILL.md is seeded");
  assert.equal(skillFile!.content, "# Runbook\n\nDo the thing.");
  const script = files.find((file) => file.path.endsWith("/scripts/check.sh"));
  assert.ok(script, "supporting file is seeded");
  const toolsJson = files.find((file) => file.path === "/workspace/.swarm/library-tools.json");
  assert.ok(toolsJson, "tools JSON is seeded");
  assert.equal(toolsJson!.content.includes("return { n: args.n };"), true, "tool code runs in the VM copy");
  assert.equal(files.find((file) => file.path === "/workspace/.swarm/library-tools-server.mjs")?.content.includes("tools/call"), true);

  const entries = libraryMcpEntries("bob");
  assert.ok(entries["library-tools"], "custom tools server is wired");
  assert.ok(Object.values(entries).some((entry: any) => entry.type === "http" && entry.url === "https://mcp.example.test/mcp" && entry.headers.API_KEY === "mcp-secret"));

  const allowed = libraryAllowedToolPermissions("bob");
  assert.ok(allowed.includes("mcp__library-tools__*"));
  assert.ok(allowed.some((permission) => permission.startsWith("mcp__lib-")));

  // Client-facing installed views never contain the secret values.
  const views = listInstalledItems("bob");
  assert.equal(JSON.stringify(views).includes("tool-secret"), false);
  assert.equal(JSON.stringify(views).includes("mcp-secret"), false);
  // The tool item exists (and its encrypted value opens for the owner).
  const storedTool = getStoredItem("bob", tool.id)!;
  assert.deepEqual(installedItemSecrets("bob", storedTool), { TOOL_TOKEN: "tool-secret" });
});

test("catalog stdio connectors substitute required positional values into argv", () => {
  const cases = [
    {
      id: "postgres",
      values: { POSTGRES_URL: "postgres://user:pass@example.test/db?x=$HOME;$(not-a-shell)" },
      positional: "POSTGRES_URL",
    },
    {
      id: "filesystem",
      values: { ALLOWED_DIRECTORY: "/workspace/shared notes;$ALLOWED_DIRECTORY" },
      positional: "ALLOWED_DIRECTORY",
    },
    {
      id: "discord",
      values: { DISCORD_BOT_TOKEN: "discord-secret", DISCORD_MCP_CONFIG: "/workspace/discord config.json" },
      positional: "DISCORD_MCP_CONFIG",
    },
  ];

  for (const entry of cases) {
    const connector = connectorById(entry.id);
    assert.ok(connector, `${entry.id} is in the catalog`);
    const payload = connectorPayload(connector);
    assert.ok(payload, `${entry.id} has an installable payload`);
    addInstalledItem("bob", {
      id: `connector-${entry.id}`,
      kind: "connector",
      name: connector.name,
      payload,
      secrets: entry.values,
    });
  }

  const entries = libraryMcpEntries("bob") as Record<string, any>;
  for (const item of cases) {
    const rendered = entries[libraryServerName(`connector-${item.id}`)];
    assert.ok(rendered, `${item.id} is wired`);
    assert.equal(rendered.args.at(-1), item.values[item.positional as keyof typeof item.values]);
    assert.deepEqual(rendered.env, item.values);
  }
});

test("MCP argument expansion supports braced/unbraced and quoted forms without shell evaluation", () => {
  addInstalledItem("bob", {
    id: "mcp-placeholders",
    kind: "mcp",
    name: "Placeholder server",
    payload: {
      transport: "stdio",
      command: "server",
      args: [
        "$POSTGRES_URL",
        '"${ALLOWED_DIRECTORIES}"',
        "'$POSTGRES_URL'",
        "--database=${POSTGRES_URL}",
        "$UNDECLARED_LITERAL",
      ],
      requiredFields: [
        { key: "POSTGRES_URL", label: "Database URL" },
        { key: "ALLOWED_DIRECTORIES", label: "Allowed directories" },
      ],
    },
    secrets: {
      POSTGRES_URL: "postgres://example.test/db;$HOME`command`",
      ALLOWED_DIRECTORIES: "/workspace/a path;/workspace/b",
    },
  });

  const entry = libraryMcpEntries("bob")[libraryServerName("mcp-placeholders")] as any;
  assert.deepEqual(entry.args, [
    "postgres://example.test/db;$HOME`command`",
    "/workspace/a path;/workspace/b",
    "postgres://example.test/db;$HOME`command`",
    "--database=postgres://example.test/db;$HOME`command`",
    "$UNDECLARED_LITERAL",
  ]);
});

test("a missing positional value fails closed without including the secret in the error", () => {
  const item = addInstalledItem("bob", {
    id: "mcp-broken-secret",
    kind: "mcp",
    name: "Broken secret server",
    payload: {
      transport: "stdio",
      command: "server",
      args: ["${POSTGRES_URL}"],
      requiredFields: [{ key: "POSTGRES_URL", label: "Database URL" }],
    },
    secrets: { POSTGRES_URL: "postgres://private-secret-value" },
  });
  const file = userLibraryFilePath("bob");
  const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
  stored.items.find((entry: any) => entry.id === item.id).sealedSecrets = {};
  fs.writeFileSync(file, JSON.stringify(stored));

  assert.throws(
    () => libraryMcpEntries("bob"),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /POSTGRES_URL/);
      assert.equal(message.includes("private-secret-value"), false);
      assert.equal(message.includes("postgres://"), false);
      return true;
    },
  );
});

// ---- store-level invariants -------------------------------------------------

test("public catalog keeps per-item ownership and never exposes owner ids in views", async () => {
  const published = await publishAs("local_alice@example.com", {
    kind: "skill",
    name: "Owned",
    payload: skillPayload("# owned"),
  });
  const record = findPublicItem(published.item.id)!;
  assert.equal(record.ownerId, "local_alice@example.com");
  const detail = await json(
    await detailGET(get("bob", `http://localhost/api/library/public/${record.id}`), {
      params: Promise.resolve({ id: record.id }),
    }),
  );
  assert.equal(JSON.stringify(detail).includes("local_alice@example.com"), false);
  assert.equal(detail.item.isOwner, false);
});

test("listPublicItems hides unpublished items and newest sort works at the store level", () => {
  publishItem("a", { kind: "skill", name: "First", payload: skillPayload("#1") });
  const second = publishItem("a", { kind: "skill", name: "Second", payload: skillPayload("#2") });
  unpublishPublicItem(second.id, "admin", { admin: true });
  const { items, total } = listPublicItems({ sort: "newest" });
  assert.equal(total, 1);
  assert.equal(items[0].name, "First");
  // Reports do not leak reporter ids through the public summary.
  const third = publishItem("b", { kind: "skill", name: "Third", payload: skillPayload("#3") });
  reportPublicItem(third.id, "reporter", "bad");
  const summary = listPublicItems({}).items.find((item) => item.id === third.id)!;
  assert.equal(JSON.stringify(summary).includes("reporter"), false);
});
