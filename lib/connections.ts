import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { HOME, MCP_CONFIG, getLimits, getProviders, newId, saveProviders } from "./store";
import { MCP_PRESETS, PRESETS, TOOL_PRESETS, apiAccess, fillTemplate, mcpPreset, presetFor, toolPreset, type ConnType, type McpTransport } from "./presets";
import { testProvider } from "./providers";
import { McpOAuthProvider, forgetMcpAuth, hasMcpTokens } from "./mcp-oauth";
import type { LearnedLimits, ProviderConfig } from "./types";

// One model for everything the user connects in Settings: LLM providers, tool API keys and MCP servers.
// Storage stays where the runtime already reads it, so nothing else has to change:
//   llm  -> settings.json  { providers: ProviderConfig[] }   (router.ts, priority = array order)
//   tool -> connections.json { tools: ToolKey[] }            (getToolKey / toolEnv for tools and the shell)
//   mcp  -> mcp.json       { mcpServers: { name: def } }     (lib/tools/mcp.ts; same shape as Claude's)
// Every file is written atomically at mode 0600. Secrets never leave the server: the browser gets a hint.

const CONNECTIONS = path.join(HOME, "connections.json");
const CLAUDE_CODE = path.join(os.homedir(), ".claude.json");
const CLAUDE_DESKTOP = path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json");

export interface ToolKey {
  id: string;
  preset: string;
  label: string;
  envVar: string;
  apiKey: string;
  enabled: boolean;
  /** Custom keys only: a GET endpoint that proves the key works (Bearer auth). */
  testUrl?: string;
}

/** An MCP server definition in mcp.json. Extra swarm fields are ignored by Claude and by the loader. */
export interface McpDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  disabled?: boolean;
  preset?: string;
  label?: string;
}

export type McpSource = "swarm" | "claude-code" | "claude-desktop";

export interface PublicConnection {
  id: string;
  type: ConnType;
  preset: string;
  label: string;
  enabled: boolean;
  /** Masked key (last 4 chars) or "" when none is stored. */
  keyHint: string;
  // llm
  kind?: string;
  model?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: string[];
  limits?: LearnedLimits;
  // tool
  envVar?: string;
  testUrl?: string;
  // mcp
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  source?: McpSource;
  /** Tool keys: hosts the api_request tool may send this key to. */
  hosts?: string[];
  /** Live runtime status from the agent's MCP loader ("connected (12 tools)" / "failed: …"), once it has connected. */
  status?: string;
  /** "connected": OAuth tokens stored; "available": the server may support OAuth sign-in. */
  oauth?: "connected" | "available";
}

/** What the Settings form sends. Secret fields left blank (or still masked) keep the stored value. */
export interface ConnectionInput {
  type: ConnType;
  id?: string;
  preset?: string;
  label?: string;
  enabled?: boolean;
  apiKey?: string;
  // llm
  baseUrl?: string;
  model?: string;
  headers?: Record<string, string>;
  vars?: Record<string, string>;
  // tool
  envVar?: string;
  testUrl?: string;
  // mcp
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export class InputError extends Error {}

// ---------- helpers ----------

const MASK = "••••";
/** Public hint for a stored key: the last 4 characters only when that's a small fraction of a long key. */
export const keyHint = (s?: string) => (!s ? "" : s.length >= 12 ? `…${s.slice(-4)}` : "set");
const hint = keyHint;
const isMasked = (v: unknown) => typeof v === "string" && v.startsWith(MASK);
/** Values that carry no secret themselves: a `{key}` template or a `${VAR}` reference to a saved key. */
const isReference = (v: string) => v.includes("{key}") || /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/.test(v.trim());
/** Header names whose values are protocol metadata, never credentials. */
const PLAIN_HEADERS = /^(content-type|accept|user-agent|anthropic-version|anthropic-beta|http-referer|referer|x-title|notion-version|openai-beta)$/i;

/** Mask every stored env/header value (short ones too). Only references and protocol headers stay readable. */
function maskValues(rec?: Record<string, string>) {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = isReference(v) || PLAIN_HEADERS.test(k) ? v : v.length >= 12 ? `${MASK}${v.slice(-4)}` : MASK;
  return out;
}

/** Merge an edited record over the stored one: masked values keep the stored secret; removed keys are dropped. */
function mergeSecrets(next: Record<string, string> | undefined, prev: Record<string, string> | undefined) {
  if (!next) return prev;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) {
    const key = k.trim();
    if (!key) continue;
    if (isMasked(v)) {
      if (prev?.[key] !== undefined) out[key] = prev[key];
    } else out[key] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

const str = (v: unknown, field: string, max = 4000) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new InputError(`${field} must be text.`);
  if (v.length > max) throw new InputError(`${field} is too long.`);
  return v.trim();
};

function validUrl(u: string, field = "URL") {
  if (/\{\w+\}/.test(u)) throw new InputError(`Fill in ${u.match(/\{(\w+)\}/)![1]} in the ${field}.`);
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error();
  } catch {
    throw new InputError(`${field} must be a full http(s) URL.`);
  }
  return u.replace(/\/+$/, "");
}

// ---------- tool keys ----------

function loadTools(): ToolKey[] {
  const file = readJson<{ tools?: ToolKey[]; importedLegacySearch?: boolean }>(CONNECTIONS, {});
  const tools = file.tools ?? [];
  // One-time import of the older single search key (settings.json `search`) so it shows up here.
  if (!file.importedLegacySearch) {
    // Only the stored key: env keys are read live and must not be copied to disk.
    const legacy = readJson<{ search?: { provider?: string; apiKey?: string } }>(path.join(HOME, "settings.json"), {}).search;
    const preset = legacy && TOOL_PRESETS.find((p) => p.id === legacy.provider);
    if (legacy?.apiKey && preset && !tools.some((t) => t.preset === preset.id)) tools.push({ id: newId(), preset: preset.id, label: preset.label, envVar: preset.envVar, apiKey: legacy.apiKey, enabled: true });
    if (legacy?.apiKey) writeJson(CONNECTIONS, { ...file, version: 1, tools, importedLegacySearch: true });
  }
  return tools;
}

function saveTools(tools: ToolKey[]) {
  const cur = readJson<Record<string, unknown>>(CONNECTIONS, {});
  writeJson(CONNECTIONS, { ...cur, version: 1, tools });
}

/** The key for a tool service (e.g. "brave"), from Settings or else the environment. */
export function getToolKey(service: string): string | undefined {
  const t = loadTools().find((k) => k.preset === service && k.enabled && k.apiKey);
  if (t) return t.apiKey;
  const envVar = TOOL_PRESETS.find((p) => p.id === service)?.envVar;
  return (envVar && process.env[envVar]) || undefined;
}

/** Search services with a usable key, in catalog order (brave, tavily, exa, serper). */
export function searchKeys(): { service: string; key: string }[] {
  return TOOL_PRESETS.filter((p) => p.builtin === "search").flatMap((p) => {
    const key = getToolKey(p.id);
    return key ? [{ service: p.id, key }] : [];
  });
}

// Names a saved key may never take over: they would change how every child process runs, or reach
// server-only settings. A key saved under one of these is simply not exported.
const RESERVED_ENV = /^(SWARM_|PATH$|HOME$|USER$|SHELL$|PWD$|TMPDIR$|NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_|BASH_ENV$|ENV$|ZDOTDIR$|PYTHONPATH$|PYTHONSTARTUP$|PERL5OPT$|RUBYOPT$|GIT_SSH|GIT_CONFIG|GIT_EXEC_PATH$|SSH_AUTH_SOCK$)/i;

/** Environment variables for the agent's shell: every enabled tool key under its variable name. */
export function toolEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const t of loadTools())
    if (t.enabled && t.apiKey && t.envVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.envVar) && !RESERVED_ENV.test(t.envVar))
      env[t.envVar] = t.apiKey;
  return env;
}

/** Masks every saved tool key that appears in `text` (e.g. `echo $GITHUB_TOKEN` output) as ••••last4,
 *  so keys exported to the shell don't land in the transcript or the model's context by accident. */
export function redactSavedKeys(text: string): string {
  if (!text) return text;
  const keys = loadTools()
    .map((t) => t.apiKey ?? "")
    .filter((k) => k.length >= 8)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const k of keys) if (out.includes(k)) out = out.split(k).join(`••••${k.length >= 12 ? k.slice(-4) : ""}`);
  return out;
}

// ---------- MCP servers ----------

interface McpFile {
  mcpServers?: Record<string, McpDef>;
  [k: string]: unknown;
}

const readMcpFile = (f: string) => readJson<McpFile>(f, {}).mcpServers ?? {};

function saveSwarmMcp(servers: Record<string, McpDef>) {
  const cur = readJson<McpFile>(MCP_CONFIG, {});
  writeJson(MCP_CONFIG, { ...cur, mcpServers: servers });
}

const mcpTransport = (d: McpDef): McpTransport => (d.url ? (d.type === "sse" ? "sse" : "http") : "stdio");

/** All MCP servers with their source; mcp.json entries override same-named imports (same rule as the loader). */
function allMcp(): { name: string; def: McpDef; source: McpSource; overridden: boolean }[] {
  const desktop = readMcpFile(CLAUDE_DESKTOP);
  const code = readMcpFile(CLAUDE_CODE);
  const swarm = readMcpFile(MCP_CONFIG);
  const out = new Map<string, { name: string; def: McpDef; source: McpSource; overridden: boolean }>();
  for (const [name, def] of Object.entries(desktop)) out.set(name, { name, def, source: "claude-desktop", overridden: false });
  for (const [name, def] of Object.entries(code)) out.set(name, { name, def, source: "claude-code", overridden: false });
  for (const [name, def] of Object.entries(swarm)) {
    const prev = out.get(name);
    out.set(name, { name, def, source: prev && prev.source !== "swarm" && def.preset === undefined ? prev.source : "swarm", overridden: !!prev });
  }
  return [...out.values()];
}

function mcpKeyHint(def: McpDef) {
  const auth = Object.entries(def.headers ?? {}).find(([k]) => /authorization|key|token/i.test(k));
  if (auth) return hint(auth[1].replace(/^(Bearer|Token|Bot)\s+/i, ""));
  const env = Object.entries(def.env ?? {}).find(([k]) => /key|token|secret/i.test(k));
  return env ? hint(env[1]) : "";
}

function slugName(label: string, taken: Set<string>) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "server";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

// The MCP runtime keeps live connections; tell it when a definition changes so the next task reconnects.
type McpResetHook = (name?: string) => void;
const hooks = globalThis as unknown as { __swarmMcpReset?: McpResetHook };
export function onMcpChange(fn: McpResetHook) {
  hooks.__swarmMcpReset = fn;
}
export function onMcpChangeNotify(name?: string) {
  mcpChanged(name);
}
function mcpChanged(name?: string) {
  try {
    hooks.__swarmMcpReset?.(name);
  } catch {}
}

// ---------- public listing ----------

export function listConnections(): PublicConnection[] {
  const limits = getLimits();
  const llm: PublicConnection[] = getProviders().map((p) => ({
    id: p.id,
    type: "llm",
    preset: p.preset ?? presetFor(p.kind).id,
    label: p.label,
    enabled: p.enabled,
    keyHint: hint(p.apiKey),
    kind: p.kind,
    model: p.model,
    baseUrl: p.baseUrl,
    headers: maskValues(p.headers),
    models: p.models,
    limits: limits[p.id] ?? { throttles: 0 },
  }));
  const tool: PublicConnection[] = loadTools().map((t) => ({
    id: t.id,
    type: "tool",
    preset: t.preset,
    label: t.label,
    enabled: t.enabled,
    keyHint: hint(t.apiKey),
    envVar: t.envVar,
    hosts: (() => {
      const p = toolPreset(t.preset);
      return p ? apiAccess(p)?.hosts : undefined;
    })(),
    testUrl: t.testUrl,
  }));
  const mcp: PublicConnection[] = allMcp().map(({ name, def, source }) => {
    const preset = def.preset ?? (def.url ? "custom-http" : "custom-stdio");
    const p = mcpPreset(preset);
    const tokens = hasMcpTokens(name);
    return {
      id: name,
      type: "mcp",
      preset,
      label: def.label ?? (def.preset && p ? p.label : name),
      status: (globalThis as unknown as { __swarmMcpStatus?: Record<string, string> }).__swarmMcpStatus?.[name],
      enabled: !def.disabled,
      keyHint: mcpKeyHint(def),
      transport: mcpTransport(def),
      command: def.command,
      args: def.args,
      url: def.url,
      env: maskValues(def.env),
      headers: maskValues(def.headers),
      source,
      oauth: tokens ? "connected" : def.url && (p?.auth === "oauth" || !p || p.id === "custom-http") ? "available" : undefined,
    };
  });
  return [...llm, ...tool, ...mcp];
}

/** The catalog shipped to the browser. */
export function catalog() {
  return { llm: PRESETS, tool: TOOL_PRESETS.map((t) => ({ ...t, apiHosts: apiAccess(t)?.hosts })), mcp: MCP_PRESETS };
}

// ---------- building configs from form input ----------

function buildProvider(input: ConnectionInput, existing?: ProviderConfig): ProviderConfig {
  const preset = presetFor(input.preset ?? existing?.preset ?? existing?.kind ?? "custom");
  const apiKey = str(input.apiKey, "API key") || existing?.apiKey || "";
  let baseUrl = str(input.baseUrl, "Base URL");
  if (!baseUrl) baseUrl = existing?.baseUrl ?? (preset.baseUrl ? fillTemplate(preset.baseUrl, input.vars ?? Object.fromEntries((preset.vars ?? []).filter((v) => v.default).map((v) => [v.key, v.default!]))) : undefined);
  if (baseUrl) baseUrl = validUrl(baseUrl, "base URL");
  if (!baseUrl && preset.kind !== "anthropic") throw new InputError("Enter the endpoint's base URL (for example http://127.0.0.1:8000/v1).");
  if (!baseUrl && preset.id === "custom-anthropic") throw new InputError("Enter the endpoint's base URL.");
  const headers = mergeSecrets(input.headers, existing?.headers) ?? (existing ? existing.headers : preset.headers);
  return {
    id: existing?.id ?? newId(),
    kind: preset.kind,
    preset: preset.id,
    label: str(input.label, "Name", 80) || existing?.label || preset.label,
    apiKey,
    baseUrl,
    model: str(input.model, "Model", 200) ?? existing?.model ?? preset.model,
    enabled: input.enabled ?? existing?.enabled ?? true,
    headers,
    models: existing?.models,
  };
}

function buildTool(input: ConnectionInput, existing?: ToolKey): ToolKey {
  const preset = toolPreset(input.preset ?? existing?.preset ?? "custom-key");
  const envVar = (str(input.envVar, "Variable name", 80) || existing?.envVar || preset.envVar).toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envVar)) throw new InputError("Variable name must look like MY_API_KEY.");
  if (RESERVED_ENV.test(envVar)) throw new InputError(`${envVar} is reserved (it changes how every command runs). Pick another name, like MY_API_KEY.`);
  const apiKey = str(input.apiKey, "API key") || existing?.apiKey || "";
  if (!apiKey) throw new InputError("Paste the API key.");
  const testUrl = str(input.testUrl, "Test URL") || (input.testUrl === "" ? undefined : existing?.testUrl);
  return {
    id: existing?.id ?? newId(),
    preset: preset.id,
    label: str(input.label, "Name", 80) || existing?.label || (preset.id === "custom-key" ? envVar : preset.label),
    envVar,
    apiKey,
    enabled: input.enabled ?? existing?.enabled ?? true,
    testUrl: testUrl ? validUrl(testUrl, "test URL") : undefined,
  };
}

function buildMcp(input: ConnectionInput, existing?: McpDef): McpDef {
  const preset = mcpPreset(input.preset ?? existing?.preset ?? "") ?? mcpPreset(input.url || existing?.url ? "custom-http" : "custom-stdio")!;
  const transport: McpTransport = input.transport ?? (existing ? mcpTransport(existing) : preset.transport);
  const def: McpDef = { preset: preset.id, label: str(input.label, "Name", 80) || existing?.label || preset.label };
  const apiKey = str(input.apiKey, "Token");
  if (transport === "stdio") {
    def.command = str(input.command, "Command", 500) ?? existing?.command ?? preset.command;
    if (!def.command) throw new InputError("Enter the command that starts the server (for example npx).");
    def.args = Array.isArray(input.args) ? input.args.map((a) => String(a)).filter((a) => a.length) : existing?.args ?? preset.args ?? [];
    def.env = mergeSecrets(input.env, existing?.env) ?? (input.env ? undefined : existing?.env);
    if (apiKey && preset.keyEnv) def.env = { ...def.env, [preset.keyEnv]: apiKey };
  } else {
    const url = str(input.url, "URL", 2000) || existing?.url || preset.url;
    if (!url) throw new InputError("Enter the server URL.");
    def.url = validUrl(url, "server URL");
    if (transport === "sse") def.type = "sse";
    else if (existing?.type && existing.type !== "sse") def.type = existing.type;
    def.headers = mergeSecrets(input.headers, existing?.headers) ?? (input.headers ? undefined : existing?.headers);
    if (apiKey && preset.keyHeader) {
      const [h, tmpl] = preset.keyHeader.split(/:\s*/, 2);
      def.headers = { ...def.headers, [h]: tmpl.split("{key}").join(apiKey) };
    } else if (apiKey) def.headers = { ...def.headers, Authorization: `Bearer ${apiKey}` };
  }
  if (preset.auth === "key" && !mcpKeyHint(def) && !def.env && !def.headers) throw new InputError(`${preset.label} needs a token.`);
  def.disabled = input.enabled === undefined ? existing?.disabled : !input.enabled || undefined;
  return def;
}

// ---------- CRUD ----------

export function upsertConnection(input: ConnectionInput): { id: string } {
  if (!input || !["llm", "tool", "mcp"].includes(input.type)) throw new InputError("Unknown connection type.");
  if (input.type === "llm") {
    const list = getProviders();
    const i = input.id ? list.findIndex((p) => p.id === input.id) : -1;
    if (input.id && i < 0) throw new InputError("That provider no longer exists.");
    const next = buildProvider(input, i >= 0 ? list[i] : undefined);
    const preset = presetFor(next.preset!);
    if (preset.needsKey && !next.apiKey) throw new InputError(`Paste your ${preset.label} API key${preset.oauth ? ", or use one-click connect" : ""}.`);
    if (!next.model) throw new InputError("Pick a model (Test lists what this key can use).");
    if (i >= 0) list[i] = next;
    else list.push(next);
    saveProviders(list);
    return { id: next.id };
  }
  if (input.type === "tool") {
    const list = loadTools();
    let i = input.id ? list.findIndex((t) => t.id === input.id) : -1;
    if (input.id && i < 0) throw new InputError("That key no longer exists.");
    // One key per built-in service: adding Brave twice replaces the first.
    if (i < 0 && input.preset && input.preset !== "custom-key") i = list.findIndex((t) => t.preset === input.preset);
    const next = buildTool(input, i >= 0 ? list[i] : undefined);
    if (list.some((t, j) => j !== i && t.envVar === next.envVar)) throw new InputError(`${next.envVar} is already used by another key.`);
    if (i >= 0) list[i] = next;
    else list.push(next);
    saveTools(list);
    return { id: next.id };
  }
  const swarm = readMcpFile(MCP_CONFIG);
  const all = allMcp();
  const found = input.id ? all.find((s) => s.name === input.id) : undefined;
  if (input.id && !found) throw new InputError("That server no longer exists.");
  const name = found?.name ?? slugName(str(input.label, "Name", 80) || mcpPreset(input.preset ?? "")?.label || "server", new Set(all.map((s) => s.name)));
  swarm[name] = buildMcp(input, found?.def);
  saveSwarmMcp(swarm);
  mcpChanged(name);
  return { id: name };
}

/** Enable/disable without touching anything else. Disabling an imported MCP server writes an override. */
export function setEnabled(type: ConnType, id: string, enabled: boolean) {
  if (type === "llm") {
    const list = getProviders();
    const p = list.find((x) => x.id === id);
    if (!p) throw new InputError("Not found.");
    p.enabled = enabled;
    saveProviders(list);
  } else if (type === "tool") {
    const list = loadTools();
    const t = list.find((x) => x.id === id);
    if (!t) throw new InputError("Not found.");
    t.enabled = enabled;
    saveTools(list);
  } else {
    const s = allMcp().find((x) => x.name === id);
    if (!s) throw new InputError("Not found.");
    const swarm = readMcpFile(MCP_CONFIG);
    swarm[id] = { ...s.def, disabled: enabled ? undefined : true };
    saveSwarmMcp(swarm);
    mcpChanged(id);
  }
}

export function deleteConnection(type: ConnType, id: string) {
  if (type === "llm") saveProviders(getProviders().filter((p) => p.id !== id));
  else if (type === "tool") saveTools(loadTools().filter((t) => t.id !== id));
  else {
    const s = allMcp().find((x) => x.name === id);
    if (!s) return;
    const swarm = readMcpFile(MCP_CONFIG);
    const imported = readMcpFile(CLAUDE_CODE)[id] ?? readMcpFile(CLAUDE_DESKTOP)[id];
    // Imported servers live in Claude's config, which we never edit; "removing" hides them here instead.
    if (imported) swarm[id] = { ...imported, disabled: true };
    else delete swarm[id];
    saveSwarmMcp(swarm);
    forgetMcpAuth(id);
    mcpChanged(id);
  }
}

export function reorderProviders(order: string[]) {
  const list = getProviders();
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  list.sort((a, b) => rank(a.id) - rank(b.id));
  saveProviders(list);
}

/** Cache a live model list on a saved provider so the picker is instant next time. */
export function cacheModels(id: string, models: string[]) {
  const list = getProviders();
  const p = list.find((x) => x.id === id);
  if (!p) return;
  p.models = models.slice(0, 2000);
  saveProviders(list);
}

// ---------- testing ----------

export interface TestResult {
  ok: boolean;
  message: string;
  models?: { id: string; context?: number }[];
  tools?: { name: string; description?: string }[];
  /** MCP: the server wants an OAuth sign-in. */
  needsAuth?: boolean;
}

function redact(message: string, secrets: (string | undefined)[]) {
  let m = message;
  for (const s of secrets) if (s && s.length >= 6) m = m.split(s).join("[redacted]");
  return m.slice(0, 400);
}

function errMessage(e: unknown) {
  const err = e as { status?: number; message?: string; cause?: { code?: string; message?: string } };
  const cause = err.cause?.code ?? err.cause?.message;
  const base = err.message || String(e);
  if (/ECONNREFUSED/.test(`${cause} ${base}`)) return "Nothing is listening at that address. Is the server running?";
  if (/ENOTFOUND|EAI_AGAIN/.test(`${cause} ${base}`)) return "That host name doesn't resolve. Check the URL.";
  if (err.status === 401 || err.status === 403) return `The provider rejected the key (HTTP ${err.status}).`;
  return cause && !base.includes(String(cause)) ? `${base} (${cause})` : base;
}

export async function testConnection(input: ConnectionInput): Promise<TestResult> {
  if (input.type === "llm") {
    const existing = input.id ? getProviders().find((p) => p.id === input.id) : undefined;
    let p: ProviderConfig;
    try {
      p = buildProvider(input, existing);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    if (presetFor(p.preset!).needsKey && !p.apiKey) return { ok: false, message: "Paste an API key first." };
    try {
      const { models, via } = await testProvider(p);
      if (existing && via === "models") cacheModels(existing.id, models.map((m) => m.id));
      return { ok: true, message: via === "ping" ? `Connected · ${p.model} answered` : `Connected · ${models.length} model${models.length === 1 ? "" : "s"}`, models };
    } catch (e) {
      return { ok: false, message: redact(errMessage(e), [p.apiKey, ...Object.values(p.headers ?? {})]) };
    }
  }

  if (input.type === "tool") {
    const existing = input.id ? loadTools().find((t) => t.id === input.id) : undefined;
    const preset = toolPreset(input.preset ?? existing?.preset ?? "custom-key");
    const key = str(input.apiKey, "API key") || existing?.apiKey;
    if (!key) return { ok: false, message: "Paste the API key first." };
    const testUrl = str(input.testUrl, "Test URL") || existing?.testUrl;
    const t = preset.test ?? (testUrl ? { url: testUrl, headers: { Authorization: "Bearer {key}" } } : undefined);
    if (!t) return { ok: true, message: "Saved keys for this service can't be checked without spending credits. It will be verified on first use." };
    const fill = (s: string) => s.split("{key}").join(key);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const headers: Record<string, string> = Object.fromEntries(Object.entries(t.headers ?? {}).map(([k, v]) => [k, fill(v)]));
      if (t.body) headers["Content-Type"] = "application/json";
      const res = await fetch(fill(t.url), { method: t.method ?? "GET", headers, body: t.body ? JSON.stringify(t.body) : undefined, signal: ctrl.signal });
      const text = await res.text();
      let json: Record<string, unknown> | undefined;
      try {
        json = JSON.parse(text);
      } catch {}
      if (res.ok && (!t.okField || json?.[t.okField])) return { ok: true, message: `Key works (${preset.label} answered ${res.status}).` };
      const detail = json ? JSON.stringify(json.error ?? json.message ?? json.detail ?? json.errors ?? json).slice(0, 200) : text.slice(0, 200);
      return { ok: false, message: redact(`${preset.label} said ${res.status}: ${detail}`, [key]) };
    } catch (e) {
      return { ok: false, message: ctrl.signal.aborted ? `${preset.label} didn't answer within 20s.` : redact(errMessage(e), [key]) };
    } finally {
      clearTimeout(timer);
    }
  }

  // mcp: connect for real, list tools, disconnect.
  const found = input.id ? allMcp().find((s) => s.name === input.id) : undefined;
  let def: McpDef;
  try {
    def = buildMcp(input, found?.def);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const name = found?.name ?? "connection-test";
  const env = def.url ? {} : mcpEnv(def.env);
  const secrets = [...Object.values(def.env ?? {}), ...Object.keys(def.env ?? {}).map((k) => env[k]), ...Object.values(def.headers ?? {})].filter((v) => v && v.length >= 6);
  const { client, close } = mcpClient();
  // For a local command, keep the tail of its stderr so a crash says why (missing file, bad flag…).
  let stderrTail = "";
  const transport = def.url ? transportFor(name, def) : new StdioClientTransport({ command: def.command!, args: def.args ?? [], env, stderr: "pipe" });
  if (transport instanceof StdioClientTransport) transport.stderr?.on("data", (b: Buffer) => (stderrTail = (stderrTail + b.toString()).slice(-2000)));
  try {
    const { tools } = await withTimeout(
      (async () => {
        await client.connect(transport);
        return client.listTools();
      })(),
      def.url ? 20_000 : 90_000,
      def.url ? "The server didn't answer within 20s." : "The command didn't start an MCP server within 90s (first npx/uvx runs download packages).",
    );
    return { ok: true, message: `Connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}`, tools: tools.map((t) => ({ name: t.name, description: t.description?.slice(0, 200) })) };
  } catch (e) {
    if (e instanceof UnauthorizedError || /401|unauthorized|invalid_token/i.test(String((e as Error).message)))
      return { ok: false, needsAuth: true, message: def.url ? "This server needs you to sign in." : "The server rejected its credentials." };
    const lines = stderrTail.split("\n").map((l) => l.trim()).filter((l) => l && !/^at /.test(l));
    const errLine = lines.filter((l) => /\b(error|cannot|not found|enoent|eacces|denied|failed|invalid|missing|required|unknown)\b/i.test(l)).at(-1);
    const why = (errLine ?? lines.slice(-2).join(" · ")).slice(0, 300);
    const msg = errMessage(e);
    return { ok: false, message: redact(why ? `${/connection closed/i.test(msg) ? "The command exited" : msg}: ${why}` : /connection closed/i.test(msg) ? "The command exited before it started an MCP server. Check the command and arguments." : msg, secrets) };
  } finally {
    await close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(message)), ms))]);
}

/** A transport for a server definition. HTTP servers get the stored OAuth tokens (refreshed automatically). */
export function transportFor(name: string, def: McpDef) {
  if (def.url) {
    const opts = { requestInit: { headers: def.headers }, authProvider: hasMcpTokens(name) ? new McpOAuthProvider(name) : undefined };
    return def.type === "sse" ? new SSEClientTransport(new URL(def.url), opts) : new StreamableHTTPClientTransport(new URL(def.url), opts);
  }
  return new StdioClientTransport({ command: def.command!, args: def.args ?? [], env: mcpEnv(def.env), stderr: "ignore" });
}

/** Non-secret variables a local server may need to find its runtime, locale, temp dir, proxy and CA certs. */
const MCP_PASSTHROUGH = /^(LANG|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|XDG_[A-Z_]+|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NVM_DIR|NVM_BIN|VOLTA_HOME|PNPM_HOME|BUN_INSTALL|PYENV_ROOT|UV_[A-Z_]+|COLORTERM)$/;

/**
 * Environment for a local (stdio) MCP server: least privilege. A third-party connector package gets the
 * SDK's minimal set (HOME, PATH, SHELL, TERM, USER, LOGNAME), a few non-secret runtime variables, and the
 * variables its own definition sets. It never inherits the server's environment (owner token, provider
 * keys) or other connectors' keys. A value can reference a saved Tool key or an env var as `${VAR}`
 * (Claude Code's syntax), so a key is only handed to the connector that names it. SWARM_* never resolves.
 */
export function mcpEnv(own: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = getDefaultEnvironment();
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && MCP_PASSTHROUGH.test(k)) env[k] = v;
  const keys = toolEnv();
  const lookup = (name: string) => (name.startsWith("SWARM_") ? "" : (keys[name] ?? process.env[name] ?? ""));
  for (const [k, v] of Object.entries(own)) {
    if (k.startsWith("SWARM_")) continue;
    env[k] = String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, dflt?: string) => lookup(name) || dflt || "");
  }
  return env;
}

function mcpClient() {
  const client = new Client({ name: "swarmagents", version: "2.0.0" });
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {}
    },
  };
}

export function mcpServerDef(name: string): McpDef | undefined {
  return allMcp().find((s) => s.name === name)?.def;
}
