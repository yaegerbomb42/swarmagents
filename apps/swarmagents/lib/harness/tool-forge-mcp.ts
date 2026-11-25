/**
 * In-VM Tool Forge MCP server (lib/harness/tool-forge-mcp.ts).
 *
 * Exposes four token-frugal tools inside every user VM:
 *   - search_mcp_catalog(query, limit) — searches the compact connector catalog
 *   - author_tool(id, name, description, runtime, code, testArgs) — writes,
 *     secret-scans, syntax-checks, smoke-tests, and registers custom tools/MCPs
 *   - list_my_tools() — lists custom tools and active VM MCP servers
 *   - manage_mcp(action, id) — inspect, enable, or disable custom MCP tools
 *
 * Dependency-free (Node builtins only) so it runs inside any VM container or host.
 */

export const TOOL_FORGE_MCP_SERVER_NAME = "tool-forge";
export const TOOL_FORGE_MCP_SERVER_PATH = "/workspace/.swarm/tool-forge-server.mjs";
export const TOOL_FORGE_CATALOG_PATH = "/workspace/.swarm/tool-catalog.json";
export const TOOL_FORGE_CUSTOM_DIR = "/workspace/.swarm/custom-tools";

export function toolForgeMcpServerSource(): string {
  return `#!/usr/bin/env node
// SwarmAgents in-VM Tool & MCP Forge server (auto-generated).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import readline from "node:readline";

const CATALOG_PATH = process.env.SWARM_TOOL_CATALOG || ${JSON.stringify(TOOL_FORGE_CATALOG_PATH)};
const CUSTOM_DIR = process.env.SWARM_CUSTOM_TOOLS_DIR || ${JSON.stringify(TOOL_FORGE_CUSTOM_DIR)};
const MANIFEST_PATH = path.join(CUSTOM_DIR, "manifest.json");
const MCP_CONFIG_PATH = process.env.SWARM_MCP_CONFIG || "/workspace/.swarm/mcp.json";
const ATLAS_PATH = process.env.SWARM_ATLAS_REGISTRY || "/workspace/.swarm/atlas/registry.json";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,48}$/;
const MAX_CODE_BYTES = 64 * 1024;
const SECRET_PATTERNS = [
  /\\bsk-[A-Za-z0-9_-]{20,}\\b/,
  /\\bghp_[A-Za-z0-9]{20,}\\b/,
  /\\bgithub_pat_[A-Za-z0-9_]{20,}\\b/,
  /\\bAKIA[0-9A-Z]{16}\\b/,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----/,
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\\n", "utf8");
  fs.renameSync(tmp, file);
}

function containsSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function scoreMatch(item, tokens) {
  const hay = (item.id + " " + item.name + " " + item.category + " " + item.summary).toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (item.id.toLowerCase().includes(tok)) score += 4;
    if (item.name.toLowerCase().includes(tok)) score += 3;
    if (hay.includes(tok)) score += 1;
  }
  return score;
}

function searchCatalog(query, limit) {
  const catalog = readJson(CATALOG_PATH, []);
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return "Catalog empty.";
  }
  const q = String(query || "").trim().toLowerCase();
  const tokens = q.split(/\\s+/).filter(Boolean);
  let ranked = catalog;
  if (tokens.length > 0) {
    ranked = catalog
      .map((item) => ({ item, score: scoreMatch(item, tokens) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }
  const slice = ranked.slice(0, Math.min(Math.max(limit || 10, 1), 25));
  if (slice.length === 0) return "No matching MCP connectors found.";
  return slice
    .map((c) => c.id + " | " + c.category + " | " + (c.oneClick ? "1-click" : "key") + " | " + c.summary)
    .join("\\n");
}

function scriptExt(runtime) {
  if (runtime === "python") return "tool.py";
  if (runtime === "bash") return "tool.sh";
  return "tool.mjs";
}

function runnerFor(runtime) {
  if (runtime === "python") return "python3";
  if (runtime === "bash") return "bash";
  return "node";
}

function buildWrapperSource(spec) {
  const runner = runnerFor(spec.runtime);
  return [
    'import { execFileSync } from "node:child_process";',
    'import readline from "node:readline";',
    "const TOOL_NAME = " + JSON.stringify(spec.id) + ";",
    "const TOOL_DESC = " + JSON.stringify(spec.description) + ";",
    "const RUNNER = " + JSON.stringify(runner) + ";",
    "const SCRIPT = " + JSON.stringify(spec.scriptPath) + ";",
    'const TOOLS = [{ name: TOOL_NAME, description: TOOL_DESC, inputSchema: { type: "object", properties: { input: { type: "string" } } } }];',
    'function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }',
    "function handle(msg) {",
    '  if (!msg || typeof msg.method !== "string") return;',
    "  const id = msg.id ?? null;",
    '  if (id === null && msg.method !== "initialize") return;',
    '  if (msg.method === "initialize") { send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "custom-" + TOOL_NAME, version: "1.0.0" } } }); return; }',
    '  if (msg.method === "tools/list") { send({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }',
    '  if (msg.method !== "tools/call") { send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }); return; }',
    "  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};",
    "  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};",
    '  const inputStr = typeof args.input === "string" ? args.input : JSON.stringify(args);',
    "  try {",
    '    const out = execFileSync(RUNNER, [SCRIPT, inputStr], { encoding: "utf8", timeout: 30000, maxBuffer: 512 * 1024, env: { ...process.env, SWARM_TOOL_INPUT: inputStr } });',
    '    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out || "(ok)" }] } });',
    "  } catch (err) {",
    '    send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(err && err.message ? err.message : err).slice(0, 1500) } });',
    "  }",
    "}",
    "const rl = readline.createInterface({ input: process.stdin, terminal: false });",
    'rl.on("line", (line) => { if (line.trim()) { try { handle(JSON.parse(line)); } catch {} } });',
  ].join("\\n");
}

function syntaxCheck(runtime, scriptPath) {
  if (runtime === "node") {
    execFileSync("node", ["--check", scriptPath], { encoding: "utf8", timeout: 10000 });
  } else if (runtime === "python") {
    execFileSync("python3", ["-m", "py_compile", scriptPath], { encoding: "utf8", timeout: 10000 });
  } else {
    execFileSync("bash", ["-n", scriptPath], { encoding: "utf8", timeout: 10000 });
  }
}

function updateAtlasEntry(entry) {
  const atlas = readJson(ATLAS_PATH, null);
  if (!atlas || typeof atlas !== "object" || !Array.isArray(atlas.entries)) return;
  const idx = atlas.entries.findIndex((e) => e && e.id === entry.id);
  if (idx >= 0) atlas.entries[idx] = entry;
  else atlas.entries.push(entry);
  writeJsonAtomic(ATLAS_PATH, atlas);
}

function syncMcpEntry(serverName, entry, enable) {
  const cfg = readJson(MCP_CONFIG_PATH, null);
  if (!cfg || typeof cfg !== "object" || !cfg.mcpServers || typeof cfg.mcpServers !== "object") return false;
  if (enable) cfg.mcpServers[serverName] = entry;
  else delete cfg.mcpServers[serverName];
  writeJsonAtomic(MCP_CONFIG_PATH, cfg);
  return true;
}

function authorTool(args) {
  const id = String(args.id || "").trim().toLowerCase();
  const name = String(args.name || "").trim();
  const description = String(args.description || "").trim();
  const runtime = String(args.runtime || "node").trim().toLowerCase();
  const code = String(args.code || "");
  if (!SLUG_RE.test(id)) return { ok: false, message: "Invalid id (2-49 lowercase a-z0-9_-)." };
  if (name.length < 2 || name.length > 80) return { ok: false, message: "Name must be 2-80 chars." };
  if (description.length < 6 || description.length > 280) return { ok: false, message: "Description must be 6-280 chars." };
  if (runtime !== "node" && runtime !== "python" && runtime !== "bash") return { ok: false, message: "Runtime must be node, python, or bash." };
  if (!code.trim() || Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) return { ok: false, message: "Code must be non-empty and <= 64 KB." };
  if (containsSecret(code)) return { ok: false, message: "Refusing code containing hardcoded secret credentials; read from process.env instead." };

  const dir = path.join(CUSTOM_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, scriptExt(runtime));
  const wrapperPath = path.join(dir, "mcp-server.mjs");
  fs.writeFileSync(scriptPath, code, { encoding: "utf8", mode: runtime === "bash" ? 0o755 : 0o644 });

  try {
    syntaxCheck(runtime, scriptPath);
  } catch (err) {
    return { ok: false, message: "Syntax check failed: " + String(err && err.stderr ? err.stderr : err.message).slice(0, 1000) };
  }

  let smokeOut = "";
  if (typeof args.testArgs === "string") {
    try {
      smokeOut = execFileSync(runnerFor(runtime), [scriptPath, args.testArgs], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, SWARM_TOOL_INPUT: args.testArgs },
      }).trim().slice(0, 500);
    } catch (err) {
      return { ok: false, message: "Smoke test failed: " + String(err && err.stderr ? err.stderr : err.message).slice(0, 1000) };
    }
  }

  fs.writeFileSync(wrapperPath, buildWrapperSource({ id, description, runtime, scriptPath }), "utf8");

  const manifest = readJson(MANIFEST_PATH, { tools: [] });
  const tools = Array.isArray(manifest.tools) ? manifest.tools.filter((t) => t && t.id !== id) : [];
  const serverName = "custom-" + id;
  const record = { id, name, description, runtime, scriptPath, wrapperPath, serverName, enabled: true, updatedAt: Date.now() };
  tools.push(record);
  writeJsonAtomic(MANIFEST_PATH, { tools });

  syncMcpEntry(serverName, { type: "stdio", command: "node", args: [wrapperPath] }, true);
  updateAtlasEntry({
    id: "custom:" + id,
    kind: "mcp_tool",
    name: name + " (" + id + ")",
    summary: "[SELF-AUTHORED] " + description,
    risk: "writes-files",
    source: serverName,
  });

  return {
    ok: true,
    text: "Tool '" + id + "' authored, verified, and registered as MCP '" + serverName + "'." + (smokeOut ? " Smoke output: " + smokeOut : ""),
  };
}

function listMyTools() {
  const manifest = readJson(MANIFEST_PATH, { tools: [] });
  const custom = Array.isArray(manifest.tools) ? manifest.tools : [];
  const cfg = readJson(MCP_CONFIG_PATH, { mcpServers: {} });
  const activeServers = cfg && cfg.mcpServers ? Object.keys(cfg.mcpServers) : [];
  const lines = [
    "Active MCP servers (" + activeServers.length + "): " + activeServers.join(", "),
    "Authored custom tools (" + custom.length + "): " + (custom.length ? custom.map((t) => t.id + "[" + (t.enabled ? "on" : "off") + "]").join(", ") : "none"),
  ];
  return lines.join("\\n");
}

function manageMcp(args) {
  const action = String(args.action || "").trim().toLowerCase();
  const id = String(args.id || "").trim().toLowerCase();
  if (!id) return { ok: false, message: "id is required." };
  const manifest = readJson(MANIFEST_PATH, { tools: [] });
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const target = tools.find((t) => t && t.id === id);
  if (!target) return { ok: false, message: "Custom tool '" + id + "' not found in manifest." };
  if (action === "inspect") {
    return { ok: true, text: JSON.stringify(target, null, 2) };
  }
  if (action === "enable" || action === "disable") {
    const enable = action === "enable";
    target.enabled = enable;
    target.updatedAt = Date.now();
    writeJsonAtomic(MANIFEST_PATH, { tools });
    syncMcpEntry(target.serverName, { type: "stdio", command: "node", args: [target.wrapperPath] }, enable);
    return { ok: true, text: "Custom MCP '" + target.serverName + "' " + (enable ? "enabled" : "disabled") + "." };
  }
  return { ok: false, message: "action must be inspect, enable, or disable." };
}

const TOOLS = [
  {
    name: "search_mcp_catalog",
    description: "Search 40+ verified MCP connectors without bloating context. Returns compact id | category | auth | summary lines.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "author_tool",
    description: "Write, syntax-check, smoke-test, and register a custom Node/Python/Bash tool as a persistent stdio MCP server in /workspace/.swarm/custom-tools.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        runtime: { type: "string", enum: ["node", "python", "bash"] },
        code: { type: "string" },
        testArgs: { type: "string" },
      },
      required: ["id", "name", "description", "runtime", "code"],
    },
  },
  {
    name: "list_my_tools",
    description: "List active VM MCP servers and authored custom tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "manage_mcp",
    description: "Inspect, enable, or disable a custom authored MCP tool.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["inspect", "enable", "disable"] },
        id: { type: "string" },
      },
      required: ["action", "id"],
    },
  },
];

function sendResult(id, text) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }) + "\\n");
}
function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}

function handleMessage(msg) {
  if (!msg || typeof msg.method !== "string") return;
  const id = msg.id ?? null;
  if (id === null && msg.method !== "initialize") return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "tool-forge", version: "1.0.0" } },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: TOOLS } }) + "\\n");
    return;
  }
  if (msg.method !== "tools/call") {
    sendError(id, -32601, "method not found");
    return;
  }
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  if (params.name === "search_mcp_catalog") {
    sendResult(id, searchCatalog(args.query, args.limit));
    return;
  }
  if (params.name === "author_tool") {
    const out = authorTool(args);
    if (out.ok) sendResult(id, out.text);
    else sendError(id, -32602, out.message);
    return;
  }
  if (params.name === "list_my_tools") {
    sendResult(id, listMyTools());
    return;
  }
  if (params.name === "manage_mcp") {
    const out = manageMcp(args);
    if (out.ok) sendResult(id, out.text);
    else sendError(id, -32602, out.message);
    return;
  }
  sendError(id, -32602, "unknown tool: " + String(params.name));
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handleMessage(JSON.parse(line));
  } catch {
    // ignore malformed json lines
  }
});
`;
}
