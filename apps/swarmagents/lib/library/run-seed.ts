/**
 * Seed an account's installed Library into that account's VM before a run.
 *
 * - Skills are written to /workspace/.claude/skills/<item>/SKILL.md (plus
 *   their supporting files), where Claude Code discovers them.
 * - Custom tools become one small MCP stdio server inside the VM
 *   (/workspace/.swarm/library-tools-server.mjs). Tool code executes there,
 *   never in the Next.js process.
 * - Installed MCP servers/connectors are added to the run's --mcp-config.
 *   Their sealed secrets are opened here and written only into the VM's
 *   config file as env/headers; they are never returned to the browser.
 *   Declared $FIELD/${FIELD} arguments are expanded here too, without a shell.
 * - Before files are written, stale item-owned skill directories and custom
 *   tool files are removed. User skills and unrelated .swarm files are kept.
 *
 * Every function is scoped by user id and reads only that account's library.
 */

import {
  readUserLibrary,
  requireItemSecrets,
  type StoredInstalledItem,
} from "./user-store";
import type { LibraryStoreOptions } from "./user-store";
import { isRecord } from "./types";
import { VmFileError } from "../vm/files";
import type { VmManager } from "../vm/manager";

export const LIBRARY_SKILLS_ROOT = "/workspace/.claude/skills";
export const LIBRARY_TOOLS_SERVER_NAME = "library-tools";
export const LIBRARY_TOOLS_SERVER_PATH = "/workspace/.swarm/library-tools-server.mjs";
export const LIBRARY_TOOLS_JSON_PATH = "/workspace/.swarm/library-tools.json";

/** MCP server name for one installed item; safe for --allowedTools. */
export function libraryServerName(itemId: string): string {
  const safe = itemId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `lib-${safe || "item"}`;
}

function toolName(itemId: string): string {
  return itemId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60) || "tool";
}

function installedItems(userId: string, options: LibraryStoreOptions): StoredInstalledItem[] {
  return readUserLibrary(userId, options).items;
}

/** Skill files for the account's installed skills. */
export function librarySkillSeedFiles(
  userId: string,
  options: LibraryStoreOptions = {},
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  for (const item of installedItems(userId, options)) {
    if (item.kind !== "skill" || item.payload.kind !== "skill") continue;
    const base = `${LIBRARY_SKILLS_ROOT}/${libraryServerName(item.id)}`;
    files.push({ path: `${base}/SKILL.md`, content: item.payload.skillMd });
    for (const file of item.payload.files) {
      if (file.path === "SKILL.md") continue; // SKILL.md above wins
      files.push({ path: `${base}/${file.path}`, content: file.content });
    }
  }
  return files;
}

interface SeededTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code: string;
  timeoutMs: number;
  env: Record<string, string>;
}

function seededTools(userId: string, options: LibraryStoreOptions): SeededTool[] {
  const tools: SeededTool[] = [];
  for (const item of installedItems(userId, options)) {
    if (item.kind !== "tool" || item.payload.kind !== "tool") continue;
    tools.push({
      name: toolName(item.id),
      description: item.description || item.name,
      inputSchema: item.payload.inputSchema,
      code: item.payload.code,
      timeoutMs: item.payload.timeoutMs,
      env: requireItemSecrets(userId, item),
    });
  }
  return tools;
}

/** The generic MCP stdio server written into the user's VM. */
export function libraryToolsServerSource(): string {
  return `#!/usr/bin/env node
// SwarmAgents library tools MCP server (auto-generated).
// Executes this account's installed custom tools INSIDE the user's VM.
import fs from "node:fs";
import { spawn } from "node:child_process";

const toolsPath = process.env.SWARM_LIBRARY_TOOLS || ${JSON.stringify(LIBRARY_TOOLS_JSON_PATH)};
let tools = [];
try {
  const parsed = JSON.parse(fs.readFileSync(toolsPath, "utf8"));
  tools = Array.isArray(parsed.tools) ? parsed.tools : [];
} catch {
  tools = [];
}
const byName = new Map(tools.map((tool) => [tool.name, tool]));

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function runTool(tool, args) {
  return new Promise((resolve) => {
    if (typeof tool.code !== "string" || !tool.code.trim()) {
      resolve({ ok: false, message: "This tool has no code." });
      return;
    }
    const wrapper = [
      "let data = '';",
      "process.stdin.setEncoding('utf8');",
      "for await (const chunk of process.stdin) data += chunk;",
      "let args = {};",
      "try { args = data ? JSON.parse(data) : {}; } catch { args = {}; }",
      "const main = async (args) => {",
      tool.code,
      "};",
      "try {",
      "  const out = await main(args);",
      "  process.stdout.write(JSON.stringify(out === undefined ? null : out));",
      "} catch (err) {",
      "  process.stderr.write(String(err && err.stack ? err.stack : err));",
      "  process.exit(1);",
      "}",
    ].join("\\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", wrapper], {
      env: { ...process.env, ...(tool.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: Math.max(1000, Number(tool.timeoutMs) || 30000),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => resolve({ ok: false, message: String(err) }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, text: stdout || "null" });
      else resolve({ ok: false, message: stderr || "Tool exited with code " + code });
    });
    child.stdin.end(JSON.stringify(args ?? {}));
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const id = msg.id;
    if (msg.method === "initialize") {
      result(id, {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "swarm-library-tools", version: "1.0.0" },
      });
    } else if (msg.method === "notifications/initialized") {
      // notification: no response
    } else if (msg.method === "ping") {
      result(id, {});
    } else if (msg.method === "tools/list") {
      result(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description || tool.name,
          inputSchema: tool.inputSchema || { type: "object", properties: {} },
        })),
      });
    } else if (msg.method === "tools/call") {
      const tool = byName.get(msg.params && msg.params.name);
      if (!tool) {
        error(id, -32602, "Unknown tool");
        continue;
      }
      const outcome = await runTool(tool, (msg.params && msg.params.arguments) || {});
      if (outcome.ok) result(id, { content: [{ type: "text", text: outcome.text }], isError: false });
      else result(id, { content: [{ type: "text", text: outcome.message }], isError: true });
    } else if (id !== undefined) {
      error(id, -32601, "Method not found");
    }
  }
});
`;
}

/** Files for the account's custom tools (JSON + the stdio server). */
export function libraryToolSeedFiles(
  userId: string,
  options: LibraryStoreOptions = {},
): Array<{ path: string; content: string }> {
  const tools = seededTools(userId, options);
  if (tools.length === 0) return [];
  const payload = {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      code: tool.code,
      timeoutMs: tool.timeoutMs,
      env: tool.env,
    })),
  };
  return [
    { path: LIBRARY_TOOLS_JSON_PATH, content: JSON.stringify(payload, null, 2) + "\n" },
    { path: LIBRARY_TOOLS_SERVER_PATH, content: libraryToolsServerSource() },
  ];
}

const ENV_PLACEHOLDER = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const EXACT_ENV_PLACEHOLDER = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

/** Only currently declared fields may be opened into an item's runtime env. */
function configuredItemEnv(
  fields: readonly { key: string }[],
  secrets: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const field of fields) {
    if (Object.hasOwn(secrets, field.key)) env[field.key] = secrets[field.key];
  }
  return env;
}

/**
 * Expand the documented $FIELD and ${FIELD} forms as data, never through a
 * shell. connectorPayload intentionally preserves catalog quotes; an exact
 * quoted placeholder loses those syntax quotes when it becomes one argv item.
 * Unknown names stay literal, while a declared but unopenable value fails
 * closed instead of passing the placeholder to the server.
 */
function expandMcpArgs(
  args: readonly string[],
  fields: readonly { key: string }[],
  env: Record<string, string>,
  itemName: string,
): string[] {
  const declared = new Set(fields.map((field) => field.key));
  const expand = (arg: string): string =>
    arg.replace(ENV_PLACEHOLDER, (_match, braced: string | undefined, bare: string | undefined) => {
      const key = braced ?? bare;
      if (!key) return _match;
      if (!declared.has(key)) return _match;
      if (!Object.hasOwn(env, key)) {
        throw new Error(`Library MCP server "${itemName}" needs a configured value for ${key} in its arguments.`);
      }
      // A replacer callback is intentional: '$' sequences in values are data.
      return env[key];
    });

  return args.map((original) => {
    const quote = original.length >= 2 ? original[0] : "";
    const quoted = (quote === '"' || quote === "'") && original.endsWith(quote);
    const inner = quoted ? original.slice(1, -1) : original;
    const exact = EXACT_ENV_PLACEHOLDER.exec(inner);
    if (exact) {
      const key = exact[1] ?? exact[2];
      if (declared.has(key)) return expand(inner);
    }
    return expand(original);
  });
}

/** Next free server name for one installed item (`base`, `base-2`, `base-3`, …). */
function uniqueServerName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * --mcp-config entries for the account's installed MCP servers/connectors
 * plus the custom-tools server. Secret values are read server-side and land
 * only in the VM config file; a sealed value that cannot be opened aborts
 * seeding instead of seeding the VM without it. Errors name the item and the
 * field, never the value.
 */
export function libraryMcpEntries(
  userId: string,
  options: LibraryStoreOptions = {},
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  const used = new Set<string>();
  for (const item of installedItems(userId, options)) {
    if (item.kind !== "mcp" && item.kind !== "connector") continue;
    if (item.payload.kind !== "mcp" && item.payload.kind !== "connector") continue;
    const name = uniqueServerName(libraryServerName(item.id), used);
    used.add(name);
    const secrets = configuredItemEnv(item.payload.requiredFields, requireItemSecrets(userId, item));
    if (item.payload.transport === "http") {
      entries[name] = {
        type: "http",
        url: item.payload.url,
        ...(Object.keys(secrets).length > 0 ? { headers: secrets } : {}),
      };
    } else {
      entries[name] = {
        type: "stdio",
        command: item.payload.command,
        args: expandMcpArgs(item.payload.args ?? [], item.payload.requiredFields, secrets, item.name),
        ...(Object.keys(secrets).length > 0 ? { env: secrets } : {}),
      };
    }
  }
  if (seededTools(userId, options).length > 0) {
    entries[LIBRARY_TOOLS_SERVER_NAME] = {
      type: "stdio",
      command: "node",
      args: [LIBRARY_TOOLS_SERVER_PATH],
      env: { SWARM_LIBRARY_TOOLS: LIBRARY_TOOLS_JSON_PATH },
    };
  }
  return entries;
}

/** --allowedTools permissions for the account's library MCP servers. */
export function libraryAllowedToolPermissions(
  userId: string,
  options: LibraryStoreOptions = {},
): string[] {
  return Object.keys(libraryMcpEntries(userId, options)).map((name) => `mcp__${name}__*`);
}

/** All VM files the account's library contributes to a run. */
export function librarySeedFiles(
  userId: string,
  options: LibraryStoreOptions = {},
): Array<{ path: string; content: string }> {
  return [...librarySkillSeedFiles(userId, options), ...libraryToolSeedFiles(userId, options)];
}

const LIBRARY_SKILL_DIRECTORY = /^lib-[a-z0-9-]+$/;

async function removeSeedPath(vm: VmManager, userId: string, path: string): Promise<void> {
  // argv + -- keeps every path data-only. rm does not follow a final symlink,
  // including with -r, so cleanup cannot be redirected to a link's target.
  const result = await vm.exec(userId, ["rm", "-rf", "--", path]);
  if (result.exitCode !== 0) throw new Error(`Could not remove stale Library path ${path}.`);
}

/**
 * Reconcile only paths owned by previous Library seeds. Library skill folders
 * use the reserved lib-* namespace; every other skill belongs to the user and
 * is not even traversed. Current item folders are preserved wholesale, while
 * the two fixed custom-tool files are removed when no installed tool needs
 * them. In particular, never empty .claude/skills or .swarm themselves.
 */
export async function cleanupLibrarySeedFiles(
  vm: VmManager,
  userId: string,
  currentFiles: readonly { path: string }[],
): Promise<void> {
  const currentPaths = new Set(currentFiles.map((file) => file.path));
  const currentSkillDirectories = new Set<string>();
  for (const file of currentFiles) {
    if (!file.path.startsWith(`${LIBRARY_SKILLS_ROOT}/`)) continue;
    const relative = file.path.slice(LIBRARY_SKILLS_ROOT.length + 1);
    const [directory, ...rest] = relative.split("/");
    if (rest.length > 0 && LIBRARY_SKILL_DIRECTORY.test(directory)) {
      currentSkillDirectories.add(directory);
    }
  }

  let skillEntries: Awaited<ReturnType<VmManager["listDir"]>>;
  try {
    skillEntries = await vm.listDir(userId, LIBRARY_SKILLS_ROOT);
  } catch (error) {
    if (error instanceof VmFileError && error.code === "not_found") skillEntries = [];
    else throw error;
  }
  for (const entry of skillEntries) {
    if (!LIBRARY_SKILL_DIRECTORY.test(entry.name)) continue;
    if (currentSkillDirectories.has(entry.name)) continue;
    await removeSeedPath(vm, userId, entry.path);
  }

  for (const path of [LIBRARY_TOOLS_JSON_PATH, LIBRARY_TOOLS_SERVER_PATH]) {
    if (currentPaths.has(path)) continue;
    try {
      await vm.stat(userId, path);
    } catch (error) {
      if (error instanceof VmFileError && error.code === "not_found") continue;
      throw error;
    }
    await removeSeedPath(vm, userId, path);
  }
}

/** Test hook: true when a record looks like a valid MCP config entry. */
export function isMcpEntry(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string";
}
