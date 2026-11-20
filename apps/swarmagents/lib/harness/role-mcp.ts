/**
 * Role-switch plumbing for the harness.
 *
 * Agent-callable role switching is implemented as a small MCP stdio server
 * (the `roles` server) that the run's claude process spawns. It exposes two
 * tools:
 *
 *   - set_role(role_id, reason?)  — validate against the user's catalog and
 *     policy, return the role that will apply on the next continuation.
 *   - list_roles()                — list the roles the agent may switch to.
 *
 * The real authority is the harness runner: it observes the same set_role call
 * in the claude stream, re-validates it (unknown ids rejected, roles outside
 * the user's allowed set rejected), emits a role.changed telemetry event, and
 * resumes the run with the new role's tools/MCP/instructions on the next
 * continuation (--resume with the new argv).
 *
 * The server script and the catalog/config JSON are written into the user's VM
 * by the runtime manager before a run starts (paths below), so claude can
 * spawn the server without any shell strings.
 */

import type { RoleDefinition } from "../roles";
import {
  BUILTIN_ROLES,
  DESKTOP_ROLE_MCP_SERVERS,
  LONG_RUNNING_WORK_TAIL,
  ROLE_SCHEMA,
  ROLE_SCHEMA_VERSION,
  ROLE_MCP_SERVER_REGISTRY,
  roleHasDesktopAccess,
} from "../roles";
import type { RolePhase } from "./types";
import { SWARM_VM_DESKTOP_ENV } from "../vm/desktop";
import { SELF_MANAGE_TAIL } from "../self-manage/prompt";
import { CODEBASE_MCP_SERVER_NAME, CODEBASE_MCP_SERVER_PATH, codebaseMcpServerSource } from "./codebase-mcp-source";
import {
  MEMORY_MCP_SERVER_NAME,
  MEMORY_MCP_SERVER_PATH,
  MEMORY_MCP_SERVER_SOURCE,
  memoryMcpServerEntry,
} from "./memory-mcp";
import {
  ASK_MCP_SERVER_NAME,
  ASK_MCP_SERVER_PATH,
  ASK_MCP_SERVER_SOURCE,
  ASK_QUESTIONS_DIR,
} from "./ask-mcp";
import {
  DESKTOP_HANDOFF_DIR,
  DESKTOP_HANDOFF_MCP_SERVER_NAME,
  DESKTOP_HANDOFF_MCP_SERVER_PATH,
  DESKTOP_HANDOFF_MCP_SERVER_SOURCE,
} from "./desktop-handoff-mcp";
import {
  PLAYWRIGHT_LAUNCHER_PATH,
  PLAYWRIGHT_LAUNCHER_SOURCE,
  PLAYWRIGHT_POLICY_PATH,
  PLAYWRIGHT_POLICY_SOURCE,
  PLAYWRIGHT_PROXY_PATH,
  PLAYWRIGHT_PROXY_SOURCE,
} from "./playwright-policy";

/** Name of the stdio MCP server exposing set_role/list_roles. */
export const ROLE_MCP_SERVER_NAME = "roles";
/** Tool names the role server exposes. */
export const ROLE_SET_ROLE_TOOL = "set_role";
export const ROLE_LIST_ROLES_TOOL = "list_roles";

/** Paths inside the user's VM where the role helper files are seeded. */
export const ROLE_MCP_CONFIG_PATH = "/workspace/.swarm/mcp.json";
export const ROLE_MCP_SERVER_PATH = "/workspace/.swarm/role-switch-server.mjs";
export const ROLE_CATALOG_PATH = "/workspace/.swarm/role-catalog.json";

/** Cap on role switches inside one run (guards against an infinite switch loop). */
export const MAX_ROLE_PHASES = 8;

/** Path (inside the VM) of the desktop computer-use MCP server source. */
export const COMPUTER_MCP_SERVER_PATH = "/opt/swarm/computer-mcp/server.mjs";
/** The Playwright MCP CLI (installed globally in both VM images). */
export const PLAYWRIGHT_MCP_COMMAND = "playwright-mcp";
/** Headless, agent-controllable browser server (distinct from desktop Playwright). */
export const BROWSER_MCP_SERVER_NAME = "browser-mcp";

/** Is desktop mode on for this process? (SWARM_VM_DESKTOP=1) */
export function desktopModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SWARM_VM_DESKTOP_ENV] === "1";
}

/**
 * The concrete --mcp-config entry for a desktop MCP server. Returns null for
 * unknown ids so a role can never wire a server this harness does not ship.
 */
export function desktopMcpServerEntry(server: string): Record<string, unknown> | null {
  if (server === "computer-mcp") {
    return {
      type: "stdio",
      command: "node",
      args: [COMPUTER_MCP_SERVER_PATH],
      env: { DISPLAY: ":1" },
    };
  }
  if (server === "playwright-mcp") {
    return {
      type: "stdio",
      command: "node",
      // Headed by default (the user sees every navigation on the desktop).
      // The launcher also starts the loopback network-policy proxy.
      args: [PLAYWRIGHT_LAUNCHER_PATH, "--browser", "chromium", "--executable-path", "/usr/bin/chromium", "--no-sandbox", "--init-page", PLAYWRIGHT_POLICY_PATH],
      env: { DISPLAY: ":1" },
    };
  }
  return null;
}

/** Concrete Playwright MCP entry for a headless VM. */
export function headlessBrowserMcpServerEntry(): Record<string, unknown> {
  return {
    type: "stdio",
    command: "node",
    args: [
      PLAYWRIGHT_LAUNCHER_PATH,
      "--browser",
      "chromium",
      "--executable-path",
      "/usr/bin/chromium",
      "--no-sandbox",
      "--headless",
      "--isolated",
      "--output-dir",
      "/workspace/.swarm/browser-output",
      "--init-page",
      PLAYWRIGHT_POLICY_PATH,
    ],
  };
}

/** Does this tool-call name belong to the role-switch server? */
export function isRoleSwitchTool(name: string): boolean {
  return name === ROLE_SET_ROLE_TOOL || name.endsWith(`__${ROLE_SET_ROLE_TOOL}`);
}

/** Does this tool-call name belong to the list_roles tool? */
export function isRoleListTool(name: string): boolean {
  return name === ROLE_LIST_ROLES_TOOL || name.endsWith(`__${ROLE_LIST_ROLES_TOOL}`);
}

/**
 * Map a role's tool ids to Claude Code permission strings for --allowedTools.
 * Unknown (imported/MCP) tool ids pass through as-is. The role-switch server,
 * the long-term memory server and the role's MCP servers are always granted.
 * The desktop MCP servers are additionally granted when the role has desktop
 * access AND desktop mode is on — never otherwise, so a non-desktop run gets
 * exactly today's toolset.
 */
export function roleAllowedTools(
  role: RoleDefinition,
  opts: { desktopMode?: boolean; tools?: boolean } = {},
): string[] {
  // Plain chat: the selected model cannot call tools at all.
  if (opts.tools === false) return [];
  const out = new Set<string>();
  for (const tool of role.tools) {
    out.add(ROLE_TOOL_PERMISSION[tool] ?? tool);
  }
  out.add(`mcp__${ROLE_MCP_SERVER_NAME}__*`);
  out.add(`mcp__${CODEBASE_MCP_SERVER_NAME}__*`);
  // Long-term memory is part of every agent's toolset: it is how the agent
  // remembers a preference between runs.
  out.add(`mcp__${MEMORY_MCP_SERVER_NAME}__*`);
  out.add(`mcp__${ASK_MCP_SERVER_NAME}__*`);
  // ask_human_desktop (shadow-to-takeover handoff) is granted to every agent
  // with tools, gated like ask_user: it only pauses the run for a human.
  out.add(`mcp__${DESKTOP_HANDOFF_MCP_SERVER_NAME}__*`);
  for (const server of role.mcpServers) {
    // Desktop servers are wired only by the gui-mode branch below.
    if (DESKTOP_ROLE_MCP_SERVERS.includes(server)) continue;
    if (server in ROLE_MCP_SERVER_REGISTRY) out.add(`mcp__${server}__*`);
  }
  if (opts.desktopMode && roleHasDesktopAccess(role)) {
    for (const server of DESKTOP_ROLE_MCP_SERVERS) out.add(`mcp__${server}__*`);
  } else if (!opts.desktopMode && role.permissions.allowBrowser && role.tools.includes("browser")) {
    out.add(`mcp__${BROWSER_MCP_SERVER_NAME}__*`);
  }
  return [...out];
}

const ROLE_TOOL_PERMISSION: Record<string, string> = {
  plan: "Plan",
  read_file: "Read",
  search: "Grep",
  write_file: "Write",
  edit_file: "Edit",
  restore_checkpoint: "Checkpoint",
  bash: "Bash",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  browser: "Browser",
  api_request: "ApiRequest",
  subagent: "Task",
};

/** Public (non-secret, compact) shape of a role for list_roles / the catalog. */
function publicRole(role: RoleDefinition): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    glyph: role.glyph,
    category: role.category,
    tools: role.tools,
    mcpServers: role.mcpServers,
    skills: role.skills,
  };
}

// ---------------------------------------------------------------------------
// --mcp-config / catalog seed files (written into the VM before the run)
// ---------------------------------------------------------------------------

/** The role catalog JSON the MCP server reads. */
export function roleCatalogJson(catalog: readonly RoleDefinition[]): string {
  return JSON.stringify({
    schema: ROLE_SCHEMA,
    version: ROLE_SCHEMA_VERSION,
    roles: catalog.filter((role) => !role.builtin || BUILTIN_ROLES.includes(role)).map(publicRole),
  });
}

/**
 * The --mcp-config file for a run under `role`. Always includes the `roles`
 * server (the switch mechanism); role-listed MCP servers that have a concrete
 * registry entry are included too. The desktop MCP servers are wired only
 * when desktop mode is on and the role has desktop access.
 */
export function roleMcpConfigJson(
  role: RolePhase,
  opts: {
    allowedRoleIds: ReadonlySet<string>;
    serverPath?: string;
    catalogPath?: string;
    desktopMode?: boolean;
    /** The catalog role definition backing this phase (custom roles need it). */
    roleDef?: RoleDefinition;
    codebaseRepoRoot?: string;
    /** Per-account MCP servers (installed Library items); never override built-ins. */
    extraMcpServers?: Record<string, unknown>;
    /** Path of the in-VM long-term memory MCP server. */
    memoryServerPath?: string;
  },
): string {
  const servers: Record<string, unknown> = {
    [ROLE_MCP_SERVER_NAME]: {
      type: "stdio",
      command: "node",
      args: [opts.serverPath ?? ROLE_MCP_SERVER_PATH],
      env: {
        SWARM_ROLE_CATALOG: opts.catalogPath ?? ROLE_CATALOG_PATH,
        SWARM_ROLE_ALLOWED: [...opts.allowedRoleIds].join(","),
      },
    },
    [CODEBASE_MCP_SERVER_NAME]: {
      type: "stdio",
      command: "node",
      args: [CODEBASE_MCP_SERVER_PATH],
      env: {
        SWARM_CODEBASE_REPO_ROOT: opts.codebaseRepoRoot ?? "/workspace",
      },
    },
    // The long-term memory server is always wired: it is the agent's way of
    // remembering a fact between runs.
    [MEMORY_MCP_SERVER_NAME]: memoryMcpServerEntry({
      serverPath: opts.memoryServerPath ?? MEMORY_MCP_SERVER_PATH,
    }),
    // ask_user pauses the run for a human decision; the harness observes the
    // same call in the stream and answers it through the question store.
    [ASK_MCP_SERVER_NAME]: {
      type: "stdio",
      command: "node",
      args: [ASK_MCP_SERVER_PATH],
      env: { SWARM_ASK_DIR: ASK_QUESTIONS_DIR },
    },
    // ask_human_desktop: hands the VM desktop to the user for a blocker the
    // agent cannot resolve; the harness observes the call and the runtime
    // resolves it through the handoff rendezvous files.
    [DESKTOP_HANDOFF_MCP_SERVER_NAME]: {
      type: "stdio",
      command: "node",
      args: [DESKTOP_HANDOFF_MCP_SERVER_PATH],
      env: { SWARM_DESKTOP_HANDOFF_DIR: DESKTOP_HANDOFF_DIR },
    },
  };
  if (opts.desktopMode) {
    const roleDef = opts.roleDef ?? roleDefinitionForId(role.roleId);
    if (roleDef && roleHasDesktopAccess(roleDef)) {
      for (const server of DESKTOP_ROLE_MCP_SERVERS) {
        const entry = desktopMcpServerEntry(server);
        if (entry) servers[server] = entry;
      }
    }
  } else {
    const roleDef = opts.roleDef ?? roleDefinitionForId(role.roleId);
    if (roleDef?.permissions.allowBrowser && roleDef.tools.includes("browser")) {
      servers[BROWSER_MCP_SERVER_NAME] = headlessBrowserMcpServerEntry();
    }
  }
  // Installed-library servers are account-scoped. Never let one shadow a
  // server the harness itself ships.
  for (const [name, entry] of Object.entries(opts.extraMcpServers ?? {})) {
    if (name in servers) continue;
    servers[name] = entry;
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

/** Look up the role definition (built-in or catalog) for a phase's role id. */
function roleDefinitionForId(roleId: string): RoleDefinition | null {
  const builtin = BUILTIN_ROLES.find((role) => role.id === roleId);
  if (builtin) return builtin;
  return null;
}

/**
 * The role-driven claude argv flags for one phase: --allowedTools (the role's
 * tool whitelist mapped to Claude Code permission strings), --mcp-config
 * (the role MCP JSON path) and optionally --append-system-prompt (the role's
 * instructions). Returns only the flag/value pairs after the fixed base argv.
 */
export function roleArgvFlags(phase: RolePhase): string[] {
  const flags: string[] = [];
  flags.push("--allowedTools", ...phase.allowedTools);
  flags.push("--mcp-config", phase.mcpConfigPath);
  if (phase.appendSystemPrompt) flags.push("--append-system-prompt", phase.appendSystemPrompt);
  return flags;
}

/** The files to seed into the VM for a role-enabled run. */
export function roleSeedFiles(
  catalog: readonly RoleDefinition[],
  allowedRoleIds: ReadonlySet<string>,
  initialPhase?: RolePhase,
  opts: { desktopMode?: boolean; codebaseRepoRoot?: string; extraMcpServers?: Record<string, unknown> } = {},
): Array<{ path: string; content: string }> {
  const phase = initialPhase ?? rolePhase(catalog[0] ?? BUILTIN_ROLES[0], opts);
  const initialDef = phase.roleId ? catalog.find((role) => role.id === phase.roleId) : undefined;
  return [
    { path: ROLE_MCP_SERVER_PATH, content: ROLE_MCP_SERVER_SOURCE },
    { path: MEMORY_MCP_SERVER_PATH, content: MEMORY_MCP_SERVER_SOURCE },
    { path: ASK_MCP_SERVER_PATH, content: ASK_MCP_SERVER_SOURCE },
    { path: DESKTOP_HANDOFF_MCP_SERVER_PATH, content: DESKTOP_HANDOFF_MCP_SERVER_SOURCE },
    { path: PLAYWRIGHT_POLICY_PATH, content: PLAYWRIGHT_POLICY_SOURCE },
    { path: PLAYWRIGHT_PROXY_PATH, content: PLAYWRIGHT_PROXY_SOURCE },
    { path: PLAYWRIGHT_LAUNCHER_PATH, content: PLAYWRIGHT_LAUNCHER_SOURCE },
    { path: ROLE_CATALOG_PATH, content: roleCatalogJson(catalog) },
    { path: CODEBASE_MCP_SERVER_PATH, content: codebaseMcpServerSource() },
    { path: ROLE_MCP_CONFIG_PATH, content: roleMcpConfigJson(phase, { allowedRoleIds, roleDef: initialDef, ...opts }) },
  ];
}

/** Build the harness phase (argv config) for a role. */
export function rolePhase(
  role: RoleDefinition,
  opts: { desktopMode?: boolean; mcpConfigPath?: string; tools?: boolean } = {},
): RolePhase {
  // The long-running-work tail rides with every role's instructions (built-in
  // and custom alike) so the agent always runs user-visible work in the
  // foreground; a role without instructions still gets the tail on its own.
  const appendSystemPrompt = [role.instructions, LONG_RUNNING_WORK_TAIL, SELF_MANAGE_TAIL]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const toolsDisabled = opts.tools === false;
  return {
    roleId: role.id,
    roleName: role.name,
    allowedTools: toolsDisabled ? [] : roleAllowedTools(role, opts),
    mcpConfigPath: toolsDisabled ? "" : opts.mcpConfigPath ?? ROLE_MCP_CONFIG_PATH,
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    ...(toolsDisabled ? { toolsDisabled: true } : {}),
  };
}

/** The prompt used to resume a run after a role switch. */
export function roleContinuationPrompt(fromRole: RoleDefinition, toRole: RoleDefinition): string {
  return (
    `[role switch] You switched from "${fromRole.name}" to "${toRole.name}" at ` +
    `${new Date().toISOString()}. Your allowed tools, MCP servers and instructions are now those of ` +
    `"${toRole.name}". Continue the task you were working on.`
  );
}

// ---------------------------------------------------------------------------
// The MCP stdio server script (written into the VM as an .mjs file).
//
// Minimal MCP stdio implementation: newline-delimited JSON-RPC 2.0 on
// stdin/stdout. It knows nothing about the harness — it validates against the
// catalog file + allowed-role env it was spawned with, so a rejected switch is
// reported to the agent immediately, and the harness independently re-runs the
// same checks before recording telemetry/resuming.
// ---------------------------------------------------------------------------

/** The role-switch MCP server source, written verbatim into the VM. */
export const ROLE_MCP_SERVER_SOURCE = [
  "#!/usr/bin/env node",
  "// SwarmAgents role-switch MCP stdio server (auto-generated).",
  "// Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout.",
  "import fs from \"node:fs\";",
  "",
  "const catalogPath = process.env.SWARM_ROLE_CATALOG || \"\";",
  "const allowedRaw = process.env.SWARM_ROLE_ALLOWED || \"\";",
  "const allowed = new Set(allowedRaw.split(\",\").map((s) => s.trim()).filter(Boolean));",
  "let catalog = [];",
  "try {",
  "  const parsed = JSON.parse(fs.readFileSync(catalogPath, \"utf8\"));",
  "  if (Array.isArray(parsed.roles)) catalog = parsed.roles;",
  "} catch (err) {",
  "  catalog = [];",
  "}",
  "",
  "const tools = [",
  "  {",
  "    name: \"set_role\",",
  "    description: \"Switch the agent to another role for the remainder of the run. The change applies on the next continuation; the harness restarts you with the new role's tools and instructions.\",",
  "    inputSchema: {",
  "      type: \"object\",",
  "      properties: {",
  "        role_id: { type: \"string\", description: \"Id of the role to switch to (see list_roles).\" },",
  "        reason: { type: \"string\", description: \"Optional short reason for the switch.\" }",
  "      },",
  "      required: [\"role_id\"]",
  "    }",
  "  },",
  "  {",
  "    name: \"list_roles\",",
  "    description: \"List the roles the agent may switch to.\",",
  "    inputSchema: { type: \"object\", properties: {} }",
  "  }",
  "];",
  "",
  "function roleId(role) {",
  "  return role && typeof role.id === \"string\" ? role.id : \"\";",
  "}",
  "",
  "function publicRole(role) {",
  "  return {",
  "    id: roleId(role),",
  "    name: role.name || roleId(role),",
  "    description: role.description || \"\",",
  "    glyph: role.glyph || \"◇\",",
  "    category: role.category || \"core\",",
  "    tools: Array.isArray(role.tools) ? role.tools : [],",
  "    mcpServers: Array.isArray(role.mcpServers) ? role.mcpServers : [],",
  "    skills: Array.isArray(role.skills) ? role.skills : []",
  "  };",
  "}",
  "",
  "function findRole(id) {",
  "  for (const role of catalog) {",
  "    if (roleId(role) === id) return role;",
  "  }",
  "  return null;",
  "}",
  "",
  "function toolResult(payload, isError) {",
  "  return {",
  "    content: [{ type: \"text\", text: JSON.stringify(payload) }],",
  "    isError: isError === true",
  "  };",
  "}",
  "",
  "function callTool(name, args) {",
  "  if (name === \"list_roles\") {",
  "    return toolResult({ roles: catalog.filter((role) => allowed.has(roleId(role))).map(publicRole) }, false);",
  "  }",
  "  if (name === \"set_role\") {",
  "    const requested = args && typeof args.role_id === \"string\" ? args.role_id.trim() : \"\";",
  "    if (!requested) return toolResult({ error: \"unknown_role\", message: \"role_id is required.\" }, true);",
  "    const role = findRole(requested);",
  "    if (!role) return toolResult({ error: \"unknown_role\", message: \"Unknown role: \" + requested }, true);",
  "    if (!allowed.has(requested)) {",
  "      return toolResult({ error: \"not_allowed\", message: \"Role \\\"\" + requested + \"\\\" is not granted for this run (it adds access the run did not start with). Ask the user to approve the escalation or pre-grant it.\" }, true);",
  "    }",
  "    return toolResult({",
  "      ok: true,",
  "      applied_next_turn: true,",
  "      role: publicRole(role),",
  "      reason: args && typeof args.reason === \"string\" ? args.reason : \"\"",
  "    }, false);",
  "  }",
  "  return toolResult({ error: \"unknown_tool\", message: \"Unknown tool: \" + name }, true);",
  "}",
  "",
  "function reply(id, result) {",
  "  process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: id, result: result }) + \"\\n\");",
  "}",
  "",
  "function replyError(id, code, message) {",
  "  process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: id, error: { code: code, message: message } }) + \"\\n\");",
  "}",
  "",
  "function handleMessage(msg) {",
  "  if (!msg || typeof msg !== \"object\") return;",
  "  const hasId = msg.id !== undefined && msg.id !== null;",
  "  const method = typeof msg.method === \"string\" ? msg.method : \"\";",
  "  if (method === \"initialize\") {",
  "    if (hasId) reply(msg.id, {",
  "      protocolVersion: (msg.params && msg.params.protocolVersion) || \"2024-11-05\",",
  "      capabilities: { tools: {} },",
  "      serverInfo: { name: \"swarm-roles\", version: \"1.0.0\" }",
  "    });",
  "    return;",
  "  }",
  "  if (method === \"ping\") {",
  "    if (hasId) reply(msg.id, {});",
  "    return;",
  "  }",
  "  if (method === \"tools/list\") {",
  "    if (hasId) reply(msg.id, { tools: tools });",
  "    return;",
  "  }",
  "  if (method === \"tools/call\") {",
  "    if (!hasId) return;",
  "    const params = msg.params && typeof msg.params === \"object\" ? msg.params : {};",
  "    const name = typeof params.name === \"string\" ? params.name : \"\";",
  "    const args = params.arguments && typeof params.arguments === \"object\" ? params.arguments : {};",
  "    reply(msg.id, callTool(name, args));",
  "    return;",
  "  }",
  "  if (method === \"notifications/initialized\" || method === \"notifications/cancelled\") return;",
  "  if (hasId) replyError(msg.id, -32601, \"Method not found: \" + method);",
  "}",
  "",
  "process.stdin.setEncoding(\"utf8\");",
  "let buffer = \"\";",
  "process.stdin.on(\"data\", (chunk) => {",
  "  buffer += chunk;",
  "  let newline;",
  "  while ((newline = buffer.indexOf(\"\\n\")) !== -1) {",
  "    const line = buffer.slice(0, newline).trim();",
  "    buffer = buffer.slice(newline + 1);",
  "    if (!line) continue;",
  "    let msg;",
  "    try { msg = JSON.parse(line); } catch (err) { continue; }",
  "    handleMessage(msg);",
  "  }",
  "});",
  "",
  "process.stdin.on(\"end\", () => {});",
  "",
].join("\n");
