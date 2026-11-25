/**
 * In-VM Tool Forge MCP server (lib/harness/tool-forge-mcp.ts).
 *
 * Exposes eight token-frugal tools inside every user VM:
 *   - search_mcp_catalog(query, limit) — searches the compact connector catalog
 *   - search_online_skills(query, source, limit) — searches 900+ online SKILL.md repos
 *   - install_online_skill(id) — installs an online SKILL.md into /workspace/.claude/skills
 *   - author_tool(id, name, description, runtime, code, testArgs, inputSchema, env) — writes,
 *     secret-scans, syntax-checks, smoke-tests, and registers custom tools/MCPs, with
 *     optional JSON Schema validation of call arguments and secret-safe env binding
 *     (env names only — values are never read, stored, or echoed)
 *   - register_mcp(id, name, description, transport, command, args, url) — registers an
 *     existing stdio (npx/uvx/node) or remote HTTP MCP server in the VM's mcp.json
 *   - list_my_tools() — lists custom tools, registered MCP servers, and active VM MCP servers
 *   - manage_mcp(action, id) — inspect, enable, disable, unregister, or remove custom MCPs
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

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const SCHEMA_PROP_TYPES = ["string", "number", "integer", "boolean", "array", "object"];
const SCHEMA_PROP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const BASE_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL"];
const MAX_SCHEMA_BYTES = 8 * 1024;

// Validate a caller-supplied JSON Schema for a custom tool's inputs. Only the
// safe object-shaped subset is accepted: type "object", a properties map of
// primitive-typed props, and required ⊆ properties. Returns an error string
// or null. The schema is never executed — it is only checked and stored.
function validateInputSchema(schema) {
  if (!isPlainObject(schema)) return "inputSchema must be a JSON object.";
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES) return "inputSchema must be <= 8 KB.";
  const keys = Object.keys(schema);
  for (const k of keys) {
    if (!["type", "properties", "required", "description"].includes(k)) return "inputSchema: unsupported top-level key '" + k + "'.";
  }
  if (schema.type !== undefined && schema.type !== "object") return "inputSchema.type must be 'object'.";
  if (schema.description !== undefined && typeof schema.description !== "string") return "inputSchema.description must be a string.";
  const props = schema.properties === undefined ? {} : schema.properties;
  if (!isPlainObject(props)) return "inputSchema.properties must be an object.";
  for (const [name, prop] of Object.entries(props)) {
    if (!SCHEMA_PROP_NAME_RE.test(name)) return "inputSchema: invalid property name '" + name + "'.";
    if (!isPlainObject(prop)) return "inputSchema: property '" + name + "' must be an object.";
    for (const pk of Object.keys(prop)) {
      if (!["type", "description", "enum"].includes(pk)) return "inputSchema: property '" + name + "' has unsupported key '" + pk + "'.";
    }
    if (prop.type !== undefined && !SCHEMA_PROP_TYPES.includes(prop.type)) return "inputSchema: property '" + name + "' has unsupported type.";
    if (prop.description !== undefined && typeof prop.description !== "string") return "inputSchema: property '" + name + "' description must be a string.";
    if (prop.enum !== undefined) {
      if (!Array.isArray(prop.enum) || prop.enum.length === 0 || prop.enum.length > 50) return "inputSchema: property '" + name + "' enum must be a non-empty array (<= 50).";
      for (const v of prop.enum) {
        if (v !== null && !["string", "number", "boolean"].includes(typeof v)) return "inputSchema: property '" + name + "' enum values must be string/number/boolean.";
      }
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) return "inputSchema.required must be an array.";
    for (const r of schema.required) {
      if (typeof r !== "string" || !(r in props)) return "inputSchema.required must name declared properties.";
    }
  }
  return null;
}

// Validate call arguments against a stored input schema. Returns an error
// string or null. Unknown extra properties are allowed (MCP clients often
// pass them); missing required props and wrong primitive types are rejected
// before the tool script ever runs.
function validateArgsAgainstSchema(schema, args) {
  if (!schema) return null;
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const r of required) {
    if (args[r] === undefined) return "Missing required argument '" + r + "'.";
  }
  for (const [name, value] of Object.entries(args)) {
    const prop = props[name];
    if (!prop || prop.type === undefined) continue;
    const t = prop.type;
    if (t === "string" && typeof value !== "string") return "Argument '" + name + "' must be a string.";
    if (t === "number" && typeof value !== "number") return "Argument '" + name + "' must be a number.";
    if (t === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return "Argument '" + name + "' must be an integer.";
    if (t === "boolean" && typeof value !== "boolean") return "Argument '" + name + "' must be a boolean.";
    if (t === "array" && !Array.isArray(value)) return "Argument '" + name + "' must be an array.";
    if (t === "object" && !isPlainObject(value)) return "Argument '" + name + "' must be an object.";
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return "Argument '" + name + "' must be one of: " + prop.enum.join(", ") + ".";
  }
  return null;
}

// Validate secret-safe env bindings: NAMES only, never values. The agent
// declares which host env vars the tool may see; values are resolved at run
// time from the wrapper's own process env and are never stored, logged, or
// echoed. Returns an error string or null.
function validateEnvNames(env) {
  if (env === undefined) return null;
  if (!Array.isArray(env)) return "env must be an array of variable names.";
  if (env.length > 10) return "env may bind at most 10 variables.";
  const seen = new Set();
  for (const name of env) {
    if (typeof name !== "string" || !ENV_NAME_RE.test(name)) return "env: invalid variable name '" + String(name) + "'.";
    if (seen.has(name)) return "env: duplicate variable '" + name + "'.";
    seen.add(name);
  }
  return null;
}

function removeAtlasEntry(entryId) {
  const atlas = readJson(ATLAS_PATH, null);
  if (!atlas || typeof atlas !== "object" || !Array.isArray(atlas.entries)) return;
  const kept = atlas.entries.filter((e) => !e || e.id !== entryId);
  if (kept.length !== atlas.entries.length) writeJsonAtomic(ATLAS_PATH, { ...atlas, entries: kept });
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
  const schema = spec.inputSchema || { type: "object", properties: { input: { type: "string" } } };
  const allowedEnv = Array.isArray(spec.env) ? spec.env : [];
  return [
    'import { execFileSync } from "node:child_process";',
    'import readline from "node:readline";',
    "const TOOL_NAME = " + JSON.stringify(spec.id) + ";",
    "const TOOL_DESC = " + JSON.stringify(spec.description) + ";",
    "const RUNNER = " + JSON.stringify(runner) + ";",
    "const SCRIPT = " + JSON.stringify(spec.scriptPath) + ";",
    "const INPUT_SCHEMA = " + JSON.stringify(schema) + ";",
    "const ALLOWED_ENV = " + JSON.stringify(allowedEnv) + ";",
    "const BASE_ENV = " + JSON.stringify(BASE_ENV_NAMES) + ";",
    'const TOOLS = [{ name: TOOL_NAME, description: TOOL_DESC, inputSchema: INPUT_SCHEMA }];',
    'function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\\\n"); }',
    "function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }",
    "function validateArgs(args) {",
    "  const props = INPUT_SCHEMA && isPlainObject(INPUT_SCHEMA.properties) ? INPUT_SCHEMA.properties : {};",
    "  const required = Array.isArray(INPUT_SCHEMA && INPUT_SCHEMA.required) ? INPUT_SCHEMA.required : [];",
    "  for (const r of required) { if (args[r] === undefined) return 'Missing required argument ' + JSON.stringify(r) + '.'; }",
    "  for (const [name, value] of Object.entries(args)) {",
    "    const prop = props[name];",
    "    if (!prop || prop.type === undefined) continue;",
    "    const t = prop.type;",
    "    if (t === 'string' && typeof value !== 'string') return 'Argument ' + JSON.stringify(name) + ' must be a string.';",
    "    if (t === 'number' && typeof value !== 'number') return 'Argument ' + JSON.stringify(name) + ' must be a number.';",
    "    if (t === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) return 'Argument ' + JSON.stringify(name) + ' must be an integer.';",
    "    if (t === 'boolean' && typeof value !== 'boolean') return 'Argument ' + JSON.stringify(name) + ' must be a boolean.';",
    "    if (t === 'array' && !Array.isArray(value)) return 'Argument ' + JSON.stringify(name) + ' must be an array.';",
    "    if (t === 'object' && !isPlainObject(value)) return 'Argument ' + JSON.stringify(name) + ' must be an object.';",
    "    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return 'Argument ' + JSON.stringify(name) + ' must be one of: ' + prop.enum.join(', ') + '.';",
    "  }",
    "  return null;",
    "}",
    "// Secret-safe env: the tool script sees ONLY the base set plus the",
    "// explicitly bound names — never the wrapper's full process env, so a",
    "// secret the agent did not bind cannot leak into a custom tool.",
    "function childEnv(inputStr) {",
    "  const env = { SWARM_TOOL_INPUT: inputStr };",
    "  for (const name of [...BASE_ENV, ...ALLOWED_ENV]) {",
    "    if (process.env[name] !== undefined) env[name] = process.env[name];",
    "  }",
    "  return env;",
    "}",
    "function handle(msg) {",
    '  if (!msg || typeof msg.method !== "string") return;',
    "  const id = msg.id ?? null;",
    '  if (id === null && msg.method !== "initialize") return;',
    '  if (msg.method === "initialize") { send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "custom-" + TOOL_NAME, version: "1.0.0" } } }); return; }',
    '  if (msg.method === "tools/list") { send({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }',
    '  if (msg.method !== "tools/call") { send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }); return; }',
    "  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};",
    "  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};",
    "  const argErr = validateArgs(args);",
    '  if (argErr) { send({ jsonrpc: "2.0", id, error: { code: -32602, message: argErr } }); return; }',
    '  const inputStr = typeof args.input === "string" ? args.input : JSON.stringify(args);',
    "  try {",
    '    const out = execFileSync(RUNNER, [SCRIPT, inputStr], { encoding: "utf8", timeout: 30000, maxBuffer: 512 * 1024, env: childEnv(inputStr) });',
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
  const inputSchema = args.inputSchema === undefined ? null : args.inputSchema;
  const schemaErr = inputSchema === null ? null : validateInputSchema(inputSchema);
  if (schemaErr) return { ok: false, message: "Invalid inputSchema: " + schemaErr };
  const envErr = validateEnvNames(args.env);
  if (envErr) return { ok: false, message: "Invalid env binding: " + envErr };
  const envNames = Array.isArray(args.env) ? [...args.env] : [];
  const existingManifest = readJson(MANIFEST_PATH, { tools: [] });
  const existingServers = Array.isArray(existingManifest.servers) ? existingManifest.servers : [];
  if (existingServers.some((s) => s && s.id === id)) {
    return { ok: false, message: "Id '" + id + "' is already registered as an MCP server; pick a different id or unregister it first." };
  }

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

  fs.writeFileSync(wrapperPath, buildWrapperSource({ id, description, runtime, scriptPath, inputSchema, env: envNames }), "utf8");

  const manifest = readJson(MANIFEST_PATH, { tools: [] });
  const tools = Array.isArray(manifest.tools) ? manifest.tools.filter((t) => t && t.id !== id) : [];
  const serverName = "custom-" + id;
  const record = { id, name, description, runtime, scriptPath, wrapperPath, serverName, enabled: true, updatedAt: Date.now() };
  if (inputSchema !== null) record.inputSchema = inputSchema;
  if (envNames.length > 0) record.env = envNames;
  tools.push(record);
  writeJsonAtomic(MANIFEST_PATH, { tools, servers: Array.isArray(manifest.servers) ? manifest.servers : [] });

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
    text: "Tool '" + id + "' authored, verified, and registered as MCP '" + serverName + "'." +
      (inputSchema !== null ? " Input schema validated (" + Object.keys(inputSchema.properties || {}).length + " props)." : "") +
      (envNames.length > 0 ? " Env bound (names only): " + envNames.join(", ") + "." : "") +
      (smokeOut ? " Smoke output: " + smokeOut : ""),
  };
}

const MCP_COMMANDS = ["npx", "uvx", "node"];
const PKG_RE = /^(@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9][a-z0-9._-]+)?$/;
// NB: no raw backtick may appear inside this file's template literal (it
// would terminate it, and the bundler unescapes hex/unicode backtick
// escapes when emitting the chunk). The backtick is built via fromCharCode.
const ARG_BAD_RE = /[\\r\\n;|&$\\\\]/;
function argHasBadChar(a) {
  return ARG_BAD_RE.test(a) || a.indexOf(String.fromCharCode(96)) !== -1;
}

function validHttpUrl(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))) return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

// Register an existing MCP server (a published npx/uvx package, a node script
// under /workspace/.swarm, or a remote HTTPS endpoint) in the VM's mcp.json.
// No secrets are accepted here: stdio servers inherit the host process env
// and HTTP servers must carry no credentials in the URL. The server id shares
// the custom-* namespace with authored tools, so collisions are rejected.
function registerMcp(args) {
  const id = String(args.id || "").trim().toLowerCase();
  const name = String(args.name || "").trim();
  const description = String(args.description || "").trim();
  const transport = String(args.transport || "").trim().toLowerCase();
  if (!SLUG_RE.test(id)) return { ok: false, message: "Invalid id (2-49 lowercase a-z0-9_-)." };
  if (name.length < 2 || name.length > 80) return { ok: false, message: "Name must be 2-80 chars." };
  if (description.length < 6 || description.length > 280) return { ok: false, message: "Description must be 6-280 chars." };
  if (transport !== "stdio" && transport !== "http") return { ok: false, message: "transport must be stdio or http." };

  let entry;
  if (transport === "stdio") {
    const command = String(args.command || "").trim();
    const cmdArgs = args.args;
    if (!MCP_COMMANDS.includes(command)) return { ok: false, message: "command must be npx, uvx, or node." };
    if (!Array.isArray(cmdArgs) || cmdArgs.length === 0 || cmdArgs.length > 20) return { ok: false, message: "args must be a non-empty array (<= 20)." };
    for (const a of cmdArgs) {
      if (typeof a !== "string" || a.length === 0 || a.length > 256 || argHasBadChar(a)) return { ok: false, message: "args must be plain strings without shell metacharacters." };
    }
    if ((command === "npx" || command === "uvx") && !PKG_RE.test(cmdArgs[0])) return { ok: false, message: "First arg for npx/uvx must be a package name (optionally @scope/name@version)." };
    if (command === "node" && !cmdArgs[0].startsWith("/workspace/.swarm/")) return { ok: false, message: "node servers must run a script under /workspace/.swarm/." };
    entry = { type: "stdio", command, args: cmdArgs };
  } else {
    const url = String(args.url || "").trim();
    if (!validHttpUrl(url)) return { ok: false, message: "url must be https (or http://localhost) with no embedded credentials." };
    if (args.command !== undefined || args.args !== undefined) return { ok: false, message: "http servers take url only, not command/args." };
    entry = { type: "http", url };
  }

  const manifest = readJson(MANIFEST_PATH, { tools: [] });
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const servers = Array.isArray(manifest.servers) ? manifest.servers : [];
  if (tools.some((t) => t && t.id === id)) return { ok: false, message: "Id '" + id + "' is already an authored tool; pick a different id." };
  if (servers.some((s) => s && s.id === id)) return { ok: false, message: "MCP server '" + id + "' is already registered; unregister it first to replace it." };

  const serverName = "custom-" + id;
  const record = { id, name, description, transport, serverName, entry, enabled: true, updatedAt: Date.now() };
  servers.push(record);
  writeJsonAtomic(MANIFEST_PATH, { tools, servers });
  syncMcpEntry(serverName, entry, true);
  updateAtlasEntry({
    id: "custom-mcp:" + id,
    kind: "mcp_server",
    name: name + " (" + id + ")",
    summary: "[REGISTERED] " + description,
    risk: transport === "http" ? "network" : "writes-files",
    source: serverName,
  });
  return { ok: true, text: "MCP server '" + id + "' registered as '" + serverName + "' (" + transport + ")." };
}

function listMyTools() {
  const manifest = readJson(MANIFEST_PATH, { tools: [] });
  const custom = Array.isArray(manifest.tools) ? manifest.tools : [];
  const servers = Array.isArray(manifest.servers) ? manifest.servers : [];
  const cfg = readJson(MCP_CONFIG_PATH, { mcpServers: {} });
  const activeServers = cfg && cfg.mcpServers ? Object.keys(cfg.mcpServers) : [];
  const lines = [
    "Active MCP servers (" + activeServers.length + "): " + activeServers.join(", "),
    "Authored custom tools (" + custom.length + "): " + (custom.length ? custom.map((t) => t.id + "[" + (t.enabled ? "on" : "off") + "]").join(", ") : "none"),
    "Registered MCP servers (" + servers.length + "): " + (servers.length ? servers.map((s) => s.id + "[" + (s.enabled ? "on" : "off") + ":" + s.transport + "]").join(", ") : "none"),
  ];
  return lines.join("\\n");
}

function manageMcp(args) {
  const action = String(args.action || "").trim().toLowerCase();
  const id = String(args.id || "").trim().toLowerCase();
  if (!id) return { ok: false, message: "id is required." };
  const manifest = readJson(MANIFEST_PATH, { tools: [] });
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const servers = Array.isArray(manifest.servers) ? manifest.servers : [];
  const tool = tools.find((t) => t && t.id === id);
  const server = servers.find((s) => s && s.id === id);
  if (!tool && !server) return { ok: false, message: "Custom tool or MCP server '" + id + "' not found in manifest." };
  if (action === "inspect") {
    return { ok: true, text: JSON.stringify(tool || server, null, 2) };
  }
  if (action === "enable" || action === "disable") {
    const enable = action === "enable";
    if (tool) {
      tool.enabled = enable;
      tool.updatedAt = Date.now();
      writeJsonAtomic(MANIFEST_PATH, { tools, servers });
      syncMcpEntry(tool.serverName, { type: "stdio", command: "node", args: [tool.wrapperPath] }, enable);
      return { ok: true, text: "Custom MCP '" + tool.serverName + "' " + (enable ? "enabled" : "disabled") + "." };
    }
    server.enabled = enable;
    server.updatedAt = Date.now();
    writeJsonAtomic(MANIFEST_PATH, { tools, servers });
    syncMcpEntry(server.serverName, server.entry, enable);
    return { ok: true, text: "Registered MCP '" + server.serverName + "' " + (enable ? "enabled" : "disabled") + "." };
  }
  if (action === "unregister") {
    if (!server) return { ok: false, message: "unregister applies to registered MCP servers; use remove for authored tools." };
    writeJsonAtomic(MANIFEST_PATH, { tools, servers: servers.filter((s) => s && s.id !== id) });
    syncMcpEntry(server.serverName, null, false);
    removeAtlasEntry("custom-mcp:" + id);
    return { ok: true, text: "Registered MCP '" + server.serverName + "' unregistered." };
  }
  if (action === "remove") {
    if (!tool) return { ok: false, message: "remove applies to authored tools; use unregister for registered MCP servers." };
    writeJsonAtomic(MANIFEST_PATH, { tools: tools.filter((t) => t && t.id !== id), servers });
    syncMcpEntry(tool.serverName, null, false);
    removeAtlasEntry("custom:" + id);
    try {
      fs.rmSync(path.dirname(tool.scriptPath), { recursive: true, force: true });
    } catch {}
    return { ok: true, text: "Custom tool '" + id + "' removed." };
  }
  return { ok: false, message: "action must be inspect, enable, disable, unregister, or remove." };
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
    description: "Write, syntax-check, smoke-test, and register a custom Node/Python/Bash tool as a persistent stdio MCP server in /workspace/.swarm/custom-tools. Optional inputSchema (JSON Schema object) is validated and enforced on every call; optional env (array of variable NAMES only, never values) binds host env vars secret-safely — the script sees only the base env plus bound names.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        runtime: { type: "string", enum: ["node", "python", "bash"] },
        code: { type: "string" },
        testArgs: { type: "string" },
        inputSchema: { type: "object" },
        env: { type: "array" },
      },
      required: ["id", "name", "description", "runtime", "code"],
    },
  },
  {
    name: "register_mcp",
    description: "Register an existing MCP server in the VM mcp.json: stdio via npx/uvx package or a node script under /workspace/.swarm, or a remote https (or http://localhost) endpoint. No credentials accepted — URLs must carry no userinfo and stdio servers inherit the host env.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        transport: { type: "string", enum: ["stdio", "http"] },
        command: { type: "string", enum: ["npx", "uvx", "node"] },
        args: { type: "array" },
        url: { type: "string" },
      },
      required: ["id", "name", "description", "transport"],
    },
  },
  {
    name: "list_my_tools",
    description: "List active VM MCP servers, authored custom tools, and registered MCP servers.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "manage_mcp",
    description: "Inspect, enable, or disable a custom authored MCP tool or registered MCP server; unregister removes a registered server, remove deletes an authored tool.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["inspect", "enable", "disable", "unregister", "remove"] },
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
  if (params.name === "register_mcp") {
    const out = registerMcp(args);
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
