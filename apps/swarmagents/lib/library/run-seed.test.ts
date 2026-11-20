/**
 * Seeding an installed library into a user's VM: skill files, the custom-tool
 * MCP server, --mcp-config entries (with secrets kept server-side until they
 * land in the VM config) and the cleanup that only touches library-owned paths.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addInstalledItem, configureLibraryStoreDir, userLibraryFilePath } from "./user-store";
import {
  LIBRARY_SKILLS_ROOT,
  LIBRARY_TOOLS_JSON_PATH,
  LIBRARY_TOOLS_SERVER_NAME,
  LIBRARY_TOOLS_SERVER_PATH,
  cleanupLibrarySeedFiles,
  isMcpEntry,
  libraryAllowedToolPermissions,
  libraryMcpEntries,
  librarySeedFiles,
  libraryServerName,
  librarySkillSeedFiles,
  libraryToolSeedFiles,
  libraryToolsServerSource,
} from "./run-seed";
import { VmFileError } from "../vm/files";
import type { VmManager } from "../vm/manager";

let dir: string;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-library-seed-"));
  configureLibraryStoreDir(dir);
});

test.afterEach(() => {
  configureLibraryStoreDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function addSkill(userId: string, name: string, markdown = "# Skill") {
  return addInstalledItem(userId, {
    kind: "skill",
    name,
    payload: {
      kind: "skill",
      skillMd: markdown,
      files: [
        { path: "SKILL.md", content: "ignored-in-favour-of-skillMd" },
        { path: "scripts/check.sh", content: "echo ok" },
      ],
      requiredFields: [],
    },
  });
}

function addTool(userId: string, name: string, secret?: string) {
  return addInstalledItem(userId, {
    kind: "tool",
    name,
    payload: {
      kind: "tool",
      language: "javascript",
      code: "return 1;",
      inputSchema: { type: "object", properties: { n: { type: "number" } } },
      requiredFields: secret ? [{ key: "TOKEN", label: "Token" }] : [],
      timeoutMs: 5000,
    },
    ...(secret ? { secrets: { TOKEN: secret } } : {}),
  });
}

function addHttpConnector(userId: string, id: string, secret?: string) {
  return addInstalledItem(userId, {
    id,
    kind: "connector",
    name: "HTTP connector",
    payload: {
      kind: "connector",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      requiredFields: secret ? [{ key: "TOKEN", label: "Token" }] : [],
      tools: ["query"],
    },
    ...(secret ? { secrets: { TOKEN: secret } } : {}),
  });
}

function addStdioMcp(
  userId: string,
  id: string,
  args: string[],
  secret?: string,
) {
  return addInstalledItem(userId, {
    id,
    kind: "mcp",
    name: "Stdio server",
    payload: {
      kind: "mcp",
      transport: "stdio",
      command: "node",
      args,
      requiredFields: secret ? [{ key: "TOKEN", label: "Token" }] : [],
      tools: [],
    },
    ...(secret ? { secrets: { TOKEN: secret } } : {}),
  });
}

/** Simulate a secret that can no longer be opened (rotated key / foreign copy). */
function stripSealedSecrets(userId: string, itemId: string): void {
  const file = userLibraryFilePath(userId);
  const library = JSON.parse(fs.readFileSync(file, "utf-8"));
  const item = library.items.find((entry: { id: string }) => entry.id === itemId);
  item.sealedSecrets = {};
  item.secretMasks = {};
  fs.writeFileSync(file, JSON.stringify(library));
}

/** Corrupt the sealed blobs in place: declared fields stay, values stop opening. */
function breakSealedSecrets(userId: string, itemId: string): void {
  const file = userLibraryFilePath(userId);
  const library = JSON.parse(fs.readFileSync(file, "utf-8"));
  const item = library.items.find((entry: { id: string }) => entry.id === itemId);
  for (const key of Object.keys(item.sealedSecrets)) {
    item.sealedSecrets[key] = "not-a-real-sealed-value";
  }
  fs.writeFileSync(file, JSON.stringify(library));
}

// ---- names -----------------------------------------------------------------

test("libraryServerName normalizes unsafe characters and truncates", () => {
  assert.equal(libraryServerName("skill-alpha"), "lib-skill-alpha");
  assert.equal(libraryServerName("Skill_Alpha!"), "lib-skill-alpha");
  assert.equal(libraryServerName("___"), "lib-item");
  assert.equal(libraryServerName(""), "lib-item");
  assert.equal(libraryServerName("x".repeat(100)), `lib-${"x".repeat(48)}`);
});

// ---- skill files -----------------------------------------------------------

test("librarySkillSeedFiles writes SKILL.md plus supporting files", () => {
  const item = addSkill("alice", "Seeded", "# Seeded skill");
  const files = librarySkillSeedFiles("alice");
  const base = `${LIBRARY_SKILLS_ROOT}/${libraryServerName(item.id)}`;
  assert.deepEqual(files, [
    { path: `${base}/SKILL.md`, content: "# Seeded skill" },
    { path: `${base}/scripts/check.sh`, content: "echo ok" },
  ]);
  assert.equal(files.filter((file) => file.path.endsWith("/SKILL.md")).length, 1);
});

test("librarySkillSeedFiles ignores tools and other accounts", () => {
  addTool("alice", "Not a skill");
  addSkill("bob", "Bobs skill");
  assert.deepEqual(librarySkillSeedFiles("alice"), []);
});

// ---- custom tools ----------------------------------------------------------

test("libraryToolSeedFiles emits the JSON manifest and the MCP server, with env", () => {
  assert.deepEqual(libraryToolSeedFiles("alice"), [], "no tools -> no files");

  const item = addTool("alice", "Counter", "test-tool-env-value");
  const files = libraryToolSeedFiles("alice");
  assert.equal(files.length, 2);
  assert.equal(files[0].path, LIBRARY_TOOLS_JSON_PATH);
  assert.equal(files[1].path, LIBRARY_TOOLS_SERVER_PATH);

  const manifest = JSON.parse(files[0].content);
  assert.equal(manifest.tools.length, 1);
  assert.equal(manifest.tools[0].name, item.id.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60));
  assert.equal(manifest.tools[0].description, "Counter");
  assert.equal(manifest.tools[0].code, "return 1;");
  assert.equal(manifest.tools[0].timeoutMs, 5000);
  assert.deepEqual(manifest.tools[0].inputSchema, { type: "object", properties: { n: { type: "number" } } });
  assert.deepEqual(manifest.tools[0].env, { TOKEN: "test-tool-env-value" });

  assert.equal(files[1].content, libraryToolsServerSource());
  assert.match(files[1].content, /tools\/call/);
  assert.match(files[1].content, /swarm-library-tools/);
  assert.match(files[1].content, /SWARM_LIBRARY_TOOLS/);
});

test("librarySeedFiles combines skills and tools", () => {
  addSkill("alice", "Skill");
  addTool("alice", "Tool");
  const paths = librarySeedFiles("alice").map((file) => file.path);
  assert.equal(paths.filter((value) => value.endsWith("/SKILL.md")).length, 1);
  assert.ok(paths.includes(LIBRARY_TOOLS_JSON_PATH));
  assert.ok(paths.includes(LIBRARY_TOOLS_SERVER_PATH));
});

// ---- MCP config ------------------------------------------------------------

test("libraryMcpEntries turns an http connector into a config entry with headers", () => {
  addHttpConnector("alice", "mcp-http", "test-http-header-value");
  const entries = libraryMcpEntries("alice");
  assert.deepEqual(entries["lib-mcp-http"], {
    type: "http",
    url: "https://mcp.example.test/mcp",
    headers: { TOKEN: "test-http-header-value" },
  });
});

test("libraryMcpEntries expands declared argument placeholders as data", () => {
  addStdioMcp(
    "alice",
    "mcp-stdio",
    [
      "--token",
      "${TOKEN}",
      "--bare",
      "$TOKEN",
      "--unknown",
      "$OTHER",
      "--exact-quoted",
      '"${TOKEN}"',
    ],
    "test-arg-value",
  );
  const entries = libraryMcpEntries("alice") as Record<string, any>;
  assert.deepEqual(entries["lib-mcp-stdio"].args, [
    "--token",
    "test-arg-value",
    "--bare",
    "test-arg-value",
    "--unknown",
    "$OTHER",
    "--exact-quoted",
    "test-arg-value",
  ]);
  assert.deepEqual(entries["lib-mcp-stdio"].env, { TOKEN: "test-arg-value" });
});

test("libraryMcpEntries fails closed when a declared argument has no value", () => {
  const item = addStdioMcp("alice", "mcp-missing", ["--token", "${TOKEN}"], "lost-value");
  stripSealedSecrets("alice", item.id);
  assert.throws(
    () => libraryMcpEntries("alice"),
    (error: unknown) =>
      error instanceof Error &&
      /needs a configured value for TOKEN/.test(error.message) &&
      !error.message.includes("lost-value"),
  );
});

test("libraryMcpEntries fails closed when an http connector's sealed secret is broken", () => {
  const item = addHttpConnector("alice", "mcp-http-broken", "test-http-secret-value");
  breakSealedSecrets("alice", item.id);
  assert.throws(
    () => libraryMcpEntries("alice"),
    (error: unknown) =>
      error instanceof Error &&
      /sealed secret for "TOKEN"/.test(error.message) &&
      !error.message.includes("test-http-secret-value"),
  );
});

test("libraryMcpEntries fails closed when a stdio server's sealed secret is broken", () => {
  const item = addStdioMcp("alice", "mcp-stdio-broken", ["--x"], "test-stdio-secret-value");
  breakSealedSecrets("alice", item.id);
  assert.throws(
    () => libraryMcpEntries("alice"),
    (error: unknown) =>
      error instanceof Error &&
      /sealed secret for "TOKEN"/.test(error.message) &&
      !error.message.includes("test-stdio-secret-value"),
  );
});

test("libraryToolSeedFiles fails closed when a tool's sealed secret is broken", () => {
  const item = addTool("alice", "Broken tool", "test-tool-env-value");
  breakSealedSecrets("alice", item.id);
  assert.throws(
    () => libraryToolSeedFiles("alice"),
    (error: unknown) =>
      error instanceof Error &&
      /sealed secret for "TOKEN"/.test(error.message) &&
      !error.message.includes("test-tool-env-value"),
  );
});

test("libraryMcpEntries de-duplicates colliding server names with incrementing suffixes", () => {
  addStdioMcp("alice", "mcp.a", ["--x"]);
  addStdioMcp("alice", "mcp-a", ["--y"]);
  addStdioMcp("alice", "mcp_a", ["--z"]);
  const names = Object.keys(libraryMcpEntries("alice")).sort();
  assert.deepEqual(names, ["lib-mcp-a", "lib-mcp-a-2", "lib-mcp-a-3"]);
});

test("libraryMcpEntries adds the custom-tools server when tools exist", () => {
  addTool("alice", "Included");
  const entries = libraryMcpEntries("alice") as Record<string, any>;
  assert.deepEqual(entries[LIBRARY_TOOLS_SERVER_NAME], {
    type: "stdio",
    command: "node",
    args: [LIBRARY_TOOLS_SERVER_PATH],
    env: { SWARM_LIBRARY_TOOLS: LIBRARY_TOOLS_JSON_PATH },
  });
});

test("libraryAllowedToolPermissions lists one wildcard permission per server", () => {
  addHttpConnector("alice", "mcp-http");
  addTool("alice", "Tool");
  assert.deepEqual(libraryAllowedToolPermissions("alice").sort(), [
    "mcp__lib-mcp-http__*",
    `mcp__${LIBRARY_TOOLS_SERVER_NAME}__*`,
  ]);
});

// ---- cleanup ---------------------------------------------------------------

interface FakeVmState {
  entries: Array<{ name: string; path: string; type: "dir" | "file"; size: number }>;
  listError?: Error;
  statResults: Map<string, Error | null>;
  execs: string[][];
  execExitCode?: number;
}

function fakeVm(state: FakeVmState): VmManager {
  return {
    async listDir() {
      if (state.listError) throw state.listError;
      return state.entries;
    },
    async stat(_userId: string, filePath: string) {
      const error = state.statResults.get(filePath);
      if (error) throw error;
      return { path: filePath, type: "file", size: 1 };
    },
    async exec(_userId: string, cmd: string[]) {
      state.execs.push(cmd);
      return { exitCode: state.execExitCode ?? 0 };
    },
  } as unknown as VmManager;
}

function state(overrides: Partial<FakeVmState> = {}): FakeVmState {
  return {
    entries: [],
    statResults: new Map(),
    execs: [],
    ...overrides,
  };
}

test("cleanup removes stale lib-* directories and keeps user directories", async () => {
  const vmState = state({
    entries: [
      { name: "lib-old", path: `${LIBRARY_SKILLS_ROOT}/lib-old`, type: "dir", size: 0 },
      { name: "user-skill", path: `${LIBRARY_SKILLS_ROOT}/user-skill`, type: "dir", size: 0 },
      { name: "lib-current", path: `${LIBRARY_SKILLS_ROOT}/lib-current`, type: "dir", size: 0 },
      { name: "README.md", path: `${LIBRARY_SKILLS_ROOT}/README.md`, type: "file", size: 10 },
    ],
    statResults: new Map([[LIBRARY_TOOLS_JSON_PATH, null], [LIBRARY_TOOLS_SERVER_PATH, null]]),
  });
  await cleanupLibrarySeedFiles(fakeVm(vmState), "alice", [
    { path: `${LIBRARY_SKILLS_ROOT}/lib-current/SKILL.md` },
  ]);
  assert.deepEqual(vmState.execs, [
    ["rm", "-rf", "--", `${LIBRARY_SKILLS_ROOT}/lib-old`],
    ["rm", "-rf", "--", LIBRARY_TOOLS_JSON_PATH],
    ["rm", "-rf", "--", LIBRARY_TOOLS_SERVER_PATH],
  ]);
});

test("cleanup keeps current tool files and skips missing ones", async () => {
  const vmState = state({
    statResults: new Map([[LIBRARY_TOOLS_JSON_PATH, null]]),
  });
  await cleanupLibrarySeedFiles(fakeVm(vmState), "alice", [
    { path: LIBRARY_TOOLS_SERVER_PATH },
  ]);
  assert.deepEqual(vmState.execs, [["rm", "-rf", "--", LIBRARY_TOOLS_JSON_PATH]]);
});

test("cleanup treats a missing skills root and missing tool files as empty", async () => {
  const vmState = state({
    listError: new VmFileError("not_found", "missing"),
    statResults: new Map([
      [LIBRARY_TOOLS_JSON_PATH, new VmFileError("not_found", "missing")],
      [LIBRARY_TOOLS_SERVER_PATH, new VmFileError("not_found", "missing")],
    ]),
  });
  await cleanupLibrarySeedFiles(fakeVm(vmState), "alice", []);
  assert.deepEqual(vmState.execs, []);
});

test("cleanup rethrows unexpected list/stat/exec failures", async () => {
  const brokenList = state({ listError: new Error("vm offline") });
  await assert.rejects(() => cleanupLibrarySeedFiles(fakeVm(brokenList), "alice", []), /vm offline/);

  const brokenStat = state({
    statResults: new Map([[LIBRARY_TOOLS_JSON_PATH, new Error("io error")]]),
  });
  await assert.rejects(() => cleanupLibrarySeedFiles(fakeVm(brokenStat), "alice", []), /io error/);

  const failedExec = state({
    entries: [{ name: "lib-old", path: `${LIBRARY_SKILLS_ROOT}/lib-old`, type: "dir", size: 0 }],
    execExitCode: 1,
  });
  await assert.rejects(() => cleanupLibrarySeedFiles(fakeVm(failedExec), "alice", []), /Could not remove/);
});

// ---- guards ----------------------------------------------------------------

test("isMcpEntry only accepts records with a string type", () => {
  assert.equal(isMcpEntry({ type: "stdio", command: "node" }), true);
  assert.equal(isMcpEntry({ type: "http" }), true);
  for (const value of [null, undefined, "http", 1, [], {}, { type: 1 }]) {
    assert.equal(isMcpEntry(value), false);
  }
});
