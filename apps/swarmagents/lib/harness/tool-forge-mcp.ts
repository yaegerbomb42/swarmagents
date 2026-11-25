/**
 * In-VM Tool Forge MCP server (lib/harness/tool-forge-mcp.ts).
 *
 * Exposes seven token-frugal tools inside every user VM:
 *   - search_mcp_catalog(query, limit) — searches the compact connector catalog
 *   - search_online_skills(query, source, limit) — searches 900+ online SKILL.md repos
 *   - install_online_skill(id) — installs an online SKILL.md into /workspace/.claude/skills
 *   - author_tool(id, name, description, runtime, code, testArgs) — writes,
 *     secret-scans, syntax-checks, smoke-tests, and registers custom tools/MCPs
 *   - list_my_tools() — lists custom tools and active VM MCP servers
 *   - manage_mcp(action, id) — inspect, enable, or disable custom MCP tools
 *   - enable_connector(connectorId) — activates a zero-key catalog connector mid-run
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
const CONNECTOR_ENABLE_URL = process.env.SWARM_CONNECTOR_ENABLE_URL || "";

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

async function enableConnector(args) {
  const connectorId = String(args.connectorId || "").trim();
  if (!connectorId) return { ok: false, message: "connectorId is required." };
  if (!CONNECTOR_ENABLE_URL) {
    return {
      ok: false,
      message: "In-run connector activation is unavailable. Configure connectors in /connectors.",
    };
  }
  try {
    const res = await fetch(CONNECTOR_ENABLE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || data.ok !== true) {
      const errMsg = data && typeof data.error === "string" ? data.error : "Connector enable failed (" + res.status + ").";
      return { ok: false, message: errMsg };
    }
    const name = data.connector && data.connector.name ? data.connector.name : connectorId;
    return { ok: true, text: "Connector '" + name + "' enabled for this account. MCP config refreshed." };
  } catch (err) {
    return { ok: false, message: "Connector enable request failed: " + String(err && err.message ? err.message : err) };
  }
}

const TOOLS = [
  {
    name: "search_mcp_catalog",
    description: "Search 680+ verified MCP connectors without bloating context. Returns compact id | category | auth | summary lines.",
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
    name: "search_online_skills",
    description: "Search 900+ open-source SKILL.md skills across anthropics/skills, openai/skills, and ComposioHQ without bloating prompt context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        source: { type: "string", enum: ["all", "anthropic", "openai", "composio"], default: "all" },
        limit: { type: "number", default: 12 },
      },
      required: ["query"],
    },
  },
  {
    name: "install_online_skill",
    description: "Download and install an online SKILL.md by id (e.g. 'anthropic/mcp-builder' or 'openai/cloudflare-deploy') into /workspace/.claude/skills.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
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
  {
    name: "enable_connector",
    description: "Enable a zero-key connector from the Swarm connector catalog for this account mid-run. Keyed connectors must be configured in /connectors.",
    inputSchema: {
      type: "object",
      properties: {
        connectorId: { type: "string", description: "Connector catalog id (e.g. exa, sqlite-read-only)." },
      },
      required: ["connectorId"],
    },
  },
];

const SKILLS_DIR = process.env.SWARM_SKILLS_DIR || "/workspace/.claude/skills";
const SKILL_ID_RE = /^(?:(anthropic|openai|composio)\\/)?([a-z0-9][a-z0-9._-]{0,64})$/i;
const SKILL_REPOS = [
  { id: "anthropic", label: "anthropics/skills", owner: "anthropics", repo: "skills", branch: "main", re: /^skills\\/([a-z0-9][a-z0-9._-]{0,64})\\/SKILL\\.md$/i },
  { id: "openai", label: "openai/skills", owner: "openai", repo: "skills", branch: "main", re: /^skills\\/\\.(?:curated|experimental)\\/([a-z0-9][a-z0-9._-]{0,64})\\/SKILL\\.md$/i },
  { id: "composio", label: "ComposioHQ/awesome-claude-skills", owner: "ComposioHQ", repo: "awesome-claude-skills", branch: "master", re: /^(?:composio-skills\\/)?([a-z0-9][a-z0-9._-]{0,64})\\/SKILL\\.md$/i },
];
let skillsCache = { expiresAt: 0, items: [] };

async function loadOnlineSkills() {
  if (skillsCache.expiresAt > Date.now() && skillsCache.items.length > 0) return skillsCache.items;
  const settled = await Promise.allSettled(SKILL_REPOS.map(async (r) => {
    const res = await fetch("https://api.github.com/repos/" + r.owner + "/" + r.repo + "/git/trees/" + r.branch + "?recursive=1", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "swarmagents-tool-forge" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const list = [];
    const seen = new Set();
    for (const node of (Array.isArray(data.tree) ? data.tree : [])) {
      if (!node || typeof node.path !== "string") continue;
      const m = r.re.exec(node.path);
      if (!m || m[1].includes("..")) continue;
      const slug = m[1];
      const id = r.id + "/" + slug;
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({
        id,
        slug,
        sourceId: r.id,
        source: r.label,
        rawUrl: "https://raw.githubusercontent.com/" + r.owner + "/" + r.repo + "/" + r.branch + "/" + node.path.split("/").map(encodeURIComponent).join("/"),
      });
    }
    return list;
  }));
  const items = [];
  for (const s of settled) {
    if (s.status === "fulfilled") items.push(...s.value);
  }
  if (items.length > 0) skillsCache = { expiresAt: Date.now() + 15 * 60 * 1000, items };
  return items;
}

async function searchOnlineSkillsTool(args) {
  const query = String(args.query || "").trim().toLowerCase();
  const source = String(args.source || "all").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 25);
  try {
    const all = await loadOnlineSkills();
    if (all.length === 0) return { ok: false, message: "Online skills registry unreachable from VM right now." };
    const tokens = query.split(/\\s+/).filter(Boolean);
    const pool = source === "all" ? all : all.filter((s) => s.sourceId === source);
    const matches = tokens.length === 0
      ? pool
      : pool.filter((s) => tokens.every((t) => s.id.toLowerCase().includes(t) || s.source.toLowerCase().includes(t)));
    const slice = matches.slice(0, limit);
    if (slice.length === 0) return { ok: true, text: "No matching online skills found." };
    return {
      ok: true,
      text: "Matched " + matches.length + " skills (showing " + slice.length + "):\\n" + slice.map((s) => s.id + " | " + s.source).join("\\n"),
    };
  } catch (err) {
    return { ok: false, message: String(err && err.message ? err.message : err) };
  }
}

async function installOnlineSkillTool(args) {
  const rawId = String(args.id || "").trim();
  const m = SKILL_ID_RE.exec(rawId);
  if (!m || rawId.includes("..")) return { ok: false, message: "Invalid skill id." };
  const sourceId = (m[1] || "anthropic").toLowerCase();
  const slug = m[2];
  const fullId = sourceId + "/" + slug;
  try {
    const all = await loadOnlineSkills().catch(() => []);
    const hit = all.find((s) => s.id.toLowerCase() === fullId.toLowerCase());
    const urls = hit
      ? [hit.rawUrl]
      : sourceId === "anthropic"
        ? ["https://raw.githubusercontent.com/anthropics/skills/main/skills/" + encodeURIComponent(slug) + "/SKILL.md"]
        : sourceId === "openai"
          ? ["https://raw.githubusercontent.com/openai/skills/main/skills/.curated/" + encodeURIComponent(slug) + "/SKILL.md"]
          : ["https://raw.githubusercontent.com/ComposioHQ/awesome-claude-skills/master/composio-skills/" + encodeURIComponent(slug) + "/SKILL.md"];
    let content = "";
    for (const u of urls) {
      const res = await fetch(u, { headers: { "User-Agent": "swarmagents-tool-forge" } });
      if (res.ok) {
        content = await res.text();
        break;
      }
    }
    if (!content.trim() || content.length > 200 * 1024) {
      return { ok: false, message: "Could not download valid SKILL.md for " + fullId };
    }
    const targetDir = path.join(SKILLS_DIR, slug);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "SKILL.md"), content, "utf8");
    updateAtlasEntry({
      id: "skill:" + slug,
      kind: "skill",
      name: slug,
      summary: "Installed online skill from " + fullId,
      risk: "read-only",
      source: fullId,
    });
    return { ok: true, text: "Installed skill '" + fullId + "' into " + path.join(targetDir, "SKILL.md") + "." };
  } catch (err) {
    return { ok: false, message: String(err && err.message ? err.message : err) };
  }
}

function sendResult(id, text) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }) + "\\n");
}
function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}

async function handleMessage(msg) {
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
  if (params.name === "search_online_skills") {
    const out = await searchOnlineSkillsTool(args);
    if (out.ok) sendResult(id, out.text);
    else sendError(id, -32000, out.message);
    return;
  }
  if (params.name === "install_online_skill") {
    const out = await installOnlineSkillTool(args);
    if (out.ok) sendResult(id, out.text);
    else sendError(id, -32602, out.message);
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
  if (params.name === "enable_connector") {
    const out = await enableConnector(args);
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
    void handleMessage(JSON.parse(line)).catch(() => {});
  } catch {
    // ignore malformed json lines
  }
});
`;
}
