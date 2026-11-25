import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPENDENCY_RADAR_TOOL,
  LOCATOR_MCP_SERVER_NAME,
  LOCATOR_MCP_SERVER_PATH,
  LOCATOR_TOOL,
  locatorMcpServerSource,
} from "./locator-mcp-source.js";
import { BUILTIN_ROLES, DEFAULT_ROLE_ID, type RoleDefinition } from "../roles.js";
import {
  roleAllowedTools,
  roleMcpConfigJson,
  rolePhase,
  roleSeedFiles,
} from "./role-mcp.js";
import type { RolePhase } from "./types.js";

interface Rpc {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: { code: number; message: string };
}

// The server shells out to ripgrep (argv array, no shell). The VM image
// ships rg; skip the search tests where the test host does not.
const hasRg = (() => {
  try {
    return spawnSync("rg", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();
const rgSkip = hasRg ? false : "ripgrep (rg) is not installed in this environment";

const mainRole = () => BUILTIN_ROLES.find((role) => role.id === DEFAULT_ROLE_ID)!;

type McpConfig = {
  mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
};

function parseConfig(json: string): McpConfig {
  return JSON.parse(json) as McpConfig;
}

/** Seed a temp workspace with known files; returns the workspace root. */
function writeWorkspace(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "many"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "auth.ts"),
    [
      "// auth helpers",
      "",
      "export function verifySession(token: string): boolean {",
      "  return token.length > 0;",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "lib", "sessionStore.ts"),
    "// verifySession is called by the middleware on every request.\nexport const store = new Map();\n",
  );
  fs.writeFileSync(path.join(root, "src", "unrelated.ts"), "export const answer = 42;\n");
  // Five files sharing one keyword, for limit/cap checks. One line is far
  // longer than the 120-char snippet cap.
  for (let i = 0; i < 5; i += 1) {
    const body =
      i === 0
        ? `const needleword = "${"x".repeat(300)}";\n`
        : `export const needleword${i} = ${i};\n`;
    fs.writeFileSync(path.join(root, "many", `file${i}.ts`), body);
  }
}

/** Run the MCP server against a temp workspace and answer the requests. */
async function ask(requests: unknown[]): Promise<{ replies: Rpc[]; workspace: string }> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-locator-"));
  writeWorkspace(workspace);

  const serverPath = path.join(workspace, "locator-server.mjs");
  fs.writeFileSync(serverPath, locatorMcpServerSource(), "utf8");

  const child = spawn("node", [serverPath], {
    env: { ...process.env, HOME: workspace, SWARM_LOCATOR_ROOT: workspace },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const replies: Rpc[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        replies.push(JSON.parse(line) as Rpc);
      } catch {
        // ignore noise
      }
    }
  });

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  // Poll for replies instead of a fixed sleep (cold node startup can take
  // ~850 ms in this VM); a hung server still fails fast at the deadline.
  const deadline = Date.now() + 5000;
  while (replies.length < requests.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  return { replies, workspace };
}

function payloadOf(replies: Rpc[], id: number): any {
  const reply = replies.find((item) => item.id === id);
  return JSON.parse(reply?.result?.content?.[0]?.text ?? "{}");
}

test("the locator MCP server lists locate_code and dependency_radar", async () => {
  const { replies, workspace } = await ask([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  try {
    const list = replies.find((reply) => reply.id === 2);
    const names = (list?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    assert.deepEqual(names, [LOCATOR_TOOL, DEPENDENCY_RADAR_TOOL]);
    assert.equal(LOCATOR_TOOL, "locate_code");
    assert.equal(DEPENDENCY_RADAR_TOOL, "dependency_radar");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("dependency_radar returns compact ripple-effect references and treats hostile input as data", { skip: rgSkip }, async () => {
  const { replies, workspace } = await ask([
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "dependency_radar", arguments: { symbol: "verifySession" } } },
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "dependency_radar", arguments: { symbol: "ab" } } },
    { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "dependency_radar", arguments: { symbol: '"; rm -rf /tmp #' } } },
  ]);
  try {
    const found = payloadOf(replies, 11);
    assert.equal(found.ok, true);
    assert.equal(found.dependents.length, 2);
    assert.match(found.text, /DEPENDENCY RADAR \(Ripple effects for 'verifySession'\):/);
    assert.match(found.text, /lib\/sessionStore\.ts:1/);

    const shortSym = payloadOf(replies, 12);
    assert.equal(shortSym.ok, true);
    assert.deepEqual(shortSym.dependents, []);

    const hostile = payloadOf(replies, 13);
    assert.equal(hostile.ok, true);
    assert.deepEqual(hostile.dependents, []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("locate_code finds a symbol with the correct file and line, definition first", { skip: rgSkip }, async () => {
  const { replies, workspace } = await ask([
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "locate_code", arguments: { query: "verifySession" } } },
  ]);
  try {
    const payload = payloadOf(replies, 3);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.keywords, ["verifySession"]);
    assert.equal(payload.targets.length, 2);
    // The definition site outranks the comment mention.
    assert.equal(payload.targets[0].filePath, "src/auth.ts");
    assert.equal(payload.targets[0].line, 3);
    assert.match(payload.targets[0].snippet, /export function verifySession/);
    assert.equal(payload.targets[1].filePath, "lib/sessionStore.ts");
    assert.equal(payload.targets[1].line, 1);
    assert.ok(payload.targets[0].score > payload.targets[1].score);
    // Compact text rendering for the model.
    assert.match(payload.text, /src\/auth\.ts:3 /);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("locate_code respects the limit and the snippet cap", { skip: rgSkip }, async () => {
  const { replies, workspace } = await ask([
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "locate_code", arguments: { query: "needleword" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "locate_code", arguments: { query: "needleword", limit: 2 } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "locate_code", arguments: { query: "needleword", limit: 99 } } },
  ]);
  try {
    const byDefault = payloadOf(replies, 4);
    assert.equal(byDefault.ok, true);
    assert.equal(byDefault.targets.length, 3); // default limit
    for (const target of byDefault.targets) {
      assert.ok(target.snippet.length <= 120, `snippet too long: ${target.snippet.length}`);
    }
    const limited = payloadOf(replies, 5);
    assert.equal(limited.targets.length, 2);
    const clamped = payloadOf(replies, 6);
    assert.equal(clamped.targets.length, 5); // 5 fixture files, limit clamped to 10
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a hostile query is treated as data, never executed", { skip: rgSkip }, async () => {
  // Sentinel path only — must not reference `workspace` inside the same
  // destructuring initializer (TDZ). If the query were shell-executed, this
  // path would be the target; we assert the fixture tree survives instead.
  const hostile = '"; rm -rf /tmp/swarm-locator-should-not-be-deleted #';
  const { replies, workspace } = await ask([
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "locate_code", arguments: { query: hostile } },
    },
  ]);
  try {
    const payload = payloadOf(replies, 7);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.targets, []);
    // The fixture tree is untouched: nothing was executed.
    assert.equal(fs.existsSync(path.join(workspace, "src", "auth.ts")), true);
    assert.equal(fs.existsSync(path.join(workspace, "many", "file0.ts")), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("an empty or keywordless query returns empty targets, not an error", async () => {
  const { replies, workspace } = await ask([
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "locate_code", arguments: { query: "a b" } } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "locate_code", arguments: { query: "" } } },
  ]);
  try {
    for (const id of [8, 9]) {
      const payload = payloadOf(replies, id);
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.targets, []);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("no match returns empty targets, not an error", { skip: rgSkip }, async () => {
  const { replies, workspace } = await ask([
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "locate_code", arguments: { query: "nonexistentSymbolXyz" } } },
  ]);
  try {
    const payload = payloadOf(replies, 10);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.targets, []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("locator: not wired, seeded, or allowed unless the role grants it", () => {
  const role = mainRole();
  assert.equal(role.mcpServers.includes(LOCATOR_MCP_SERVER_NAME), false);
  const phase: RolePhase = rolePhase(role);
  const config = parseConfig(roleMcpConfigJson(phase, { allowedRoleIds: new Set([role.id]) }));
  assert.equal(config.mcpServers[LOCATOR_MCP_SERVER_NAME], undefined);
  const files = roleSeedFiles(BUILTIN_ROLES, new Set([role.id]));
  assert.equal(files.some((file) => file.path === LOCATOR_MCP_SERVER_PATH), false);
  assert.equal(roleAllowedTools(role).includes(`mcp__${LOCATOR_MCP_SERVER_NAME}__*`), false);
});

test("locator: wired, seeded, and allowed when the role grants it", () => {
  const role: RoleDefinition = { ...mainRole(), mcpServers: [LOCATOR_MCP_SERVER_NAME] };
  const phase: RolePhase = rolePhase(role);
  const config = parseConfig(
    roleMcpConfigJson(phase, { allowedRoleIds: new Set([role.id]), roleDef: role }),
  );
  const entry = config.mcpServers[LOCATOR_MCP_SERVER_NAME];
  assert.equal(entry?.command, "node");
  assert.deepEqual(entry?.args, [LOCATOR_MCP_SERVER_PATH]);
  assert.equal(entry?.env?.SWARM_LOCATOR_ROOT, "/workspace");
  const files = roleSeedFiles([role], new Set([role.id]), phase);
  const seeded = files.find((file) => file.path === LOCATOR_MCP_SERVER_PATH);
  assert.ok(seeded);
  assert.equal(seeded?.content, locatorMcpServerSource());
  assert.equal(roleAllowedTools(role).includes(`mcp__${LOCATOR_MCP_SERVER_NAME}__*`), true);
});
