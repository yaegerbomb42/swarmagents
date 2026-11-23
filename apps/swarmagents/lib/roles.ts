// Declarative role schemas for the swarm UI.
//
// A role is a small, portable description of how an agent should behave: which
// model it uses, which permissions it has, which tools it may call, which MCP
// servers and skills it can use, and the instructions it works from. Built-in
// roles live here; users can copy them or create custom roles in RoleCatalogModal
// and move them between machines as JSON.
//
// This module is dependency-free (no React, no node:*) so the catalog can render
// in the browser and the server runtime can import the same definitions.

import { isLensId, type LensId } from "./lenses/types";

export const ROLE_SCHEMA = "swarmagents.roles";
// v2 adds `category`, `mcpServers` and `skills` to RoleDefinition. v1 bundles
// (custom roles saved before the role library grew) still parse: their roles
// are normalized to v2 defaults (category "core", empty MCP/skill lists).
export const ROLE_SCHEMA_VERSION = 2;
export const ROLES_STORAGE_KEY = "swarmagents.roles.custom.v1";

/** The default role a fresh workspace starts with (A1, the generalist). The id stays "main" for persisted selections. */
export const DEFAULT_ROLE_ID = "main";

// ---- Categories ----

export const ROLE_CATEGORIES = [
  { id: "core", label: "Core", hint: "Generalist and coordination roles." },
  { id: "build", label: "Build", hint: "Writing code and shaping the product." },
  { id: "quality", label: "Quality", hint: "Review, testing, security and verification." },
  { id: "ops", label: "Ops", hint: "Deployment, infrastructure and operations." },
  { id: "research", label: "Research", hint: "Discovery, analysis and communication." },
] as const;

export type RoleCategory = (typeof ROLE_CATEGORIES)[number]["id"];

export const ROLE_CATEGORY_BY_ID: ReadonlyMap<RoleCategory, { label: string; hint: string }> = new Map(
  ROLE_CATEGORIES.map((category) => [category.id, category] as const),
);

// ---- Permissions ----

export const PERMISSION_KEYS = [
  "readOnly",
  "allowBash",
  "allowWrite",
  "allowNetwork",
  "allowBrowser",
  "allowSubagents",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type RolePermissions = Record<PermissionKey, boolean>;

export interface PermissionMeta {
  key: PermissionKey;
  label: string;
  hint: string;
}

export const PERMISSIONS: readonly PermissionMeta[] = [
  {
    key: "readOnly",
    label: "Read-only",
    hint: "Block file writes and edits. Bash can still change files if it is allowed.",
  },
  {
    key: "allowBash",
    label: "Shell",
    hint: "Run commands in the workspace (tests, builds, git).",
  },
  {
    key: "allowWrite",
    label: "Write files",
    hint: "Create, edit and restore files in the workspace.",
  },
  {
    key: "allowNetwork",
    label: "Network",
    hint: "Reach external services through web and API tools.",
  },
  {
    key: "allowBrowser",
    label: "Browser",
    hint: "Drive the shared headless browser.",
  },
  {
    key: "allowSubagents",
    label: "Sub-agents",
    hint: "Split independent work across parallel sub-agents.",
  },
];

// ---- Tool whitelist ----

export interface RoleTool {
  name: string;
  label: string;
  hint: string;
  /** Tools that can change the workspace or the outside world. */
  mutating: boolean;
  /** Claude Code permission string the tool maps to (used for --allowedTools). */
  claude: string;
}

export const ROLE_TOOLS: readonly RoleTool[] = [
  { name: "plan", label: "Plan", hint: "Keep the visible task plan up to date.", mutating: false, claude: "Plan" },
  { name: "read_file", label: "Read file", hint: "Read a file with line numbers.", mutating: false, claude: "Read" },
  { name: "search", label: "Search", hint: "Search file contents with ripgrep.", mutating: false, claude: "Grep" },
  { name: "write_file", label: "Write file", hint: "Create or replace a file.", mutating: true, claude: "Write" },
  { name: "edit_file", label: "Edit file", hint: "Replace an exact string in a file.", mutating: true, claude: "Edit" },
  { name: "restore_checkpoint", label: "Restore checkpoint", hint: "Undo a write or edit from its snapshot.", mutating: true, claude: "Checkpoint" },
  { name: "bash", label: "Bash", hint: "Run shell commands in the workspace.", mutating: true, claude: "Bash" },
  { name: "web_search", label: "Web search", hint: "Search the web for current information.", mutating: false, claude: "WebSearch" },
  { name: "web_fetch", label: "Web fetch", hint: "Fetch and read a URL.", mutating: false, claude: "WebFetch" },
  { name: "browser", label: "Browser", hint: "Drive the shared headless browser.", mutating: true, claude: "Browser" },
  { name: "api_request", label: "API request", hint: "Call an API using a saved tool key.", mutating: true, claude: "ApiRequest" },
  { name: "subagent", label: "Sub-agent", hint: "Delegate independent pieces of work in parallel.", mutating: true, claude: "Task" },
  // Read-only explorer subagent (lib/harness/explorer.ts): answers a codebase
  // question with a verified Ground-Truth Brief. Non-mutating; the VM-side
  // MCP server that serves it to Claude is a follow-up to the runtime.
  { name: "dispatch_explorer", label: "Explorer", hint: "Dispatch a read-only explorer subagent to answer a codebase question.", mutating: false, claude: "dispatch_explorer" },
];

const TOOL_LABELS = new Map(ROLE_TOOLS.map((tool) => [tool.name, tool.label] as const));

/** Human label for a tool id; unknown (imported/MCP) tools keep their name. */
export function toolLabel(name: string): string {
  return TOOL_LABELS.get(name) ?? name;
}

// ---- Role definition ----

export interface RoleDefinition {
  /** Stable slug used for storage and references (e.g. "orchestrator"). */
  id: string;
  name: string;
  description: string;
  /** One or two characters shown on the role card. */
  glyph: string;
  /** Model id; "" follows the workspace/model selected in the composer. */
  model: string;
  permissions: RolePermissions;
  /** Tool names this role may call. Empty means no tools. */
  tools: string[];
  /** MCP server ids this role may use (see ROLE_MCP_SERVER_REGISTRY). */
  mcpServers: string[];
  /** Skill ids this role may use. */
  skills: string[];
  /** Prepended to the agent's system prompt when this role drives a run. */
  instructions: string;
  /** Catalog grouping for the role catalog (Core / Build / Quality / Ops / Research). */
  category: RoleCategory;
  /** Built-ins ship with the app and cannot be edited or deleted. */
  builtin: boolean;
  /**
   * A lens pinned to this role: when a run driven by this role finishes, the
   * lens automatically re-reads the run's artifact diff on the cheapest capable
   * model and a pass/warn verdict is attached to the run. Omitted = no auto
   * audit. Configurable per role (e.g. Coder → security).
   */
  lens?: LensId;
}

const permissions = (overrides: Partial<RolePermissions>): RolePermissions => ({
  readOnly: false,
  allowBash: false,
  allowWrite: false,
  allowNetwork: false,
  allowBrowser: false,
  allowSubagents: false,
  ...overrides,
});

// MCP server ids a role can reference. The registry is intentionally small:
// only servers with a concrete definition here can be wired into a run's
// --mcp-config. The role-switch server is always present and managed by the
// harness, so it is not listed here.
export const ROLE_MCP_SERVER_REGISTRY: Readonly<Record<string, { label: string; description: string }>> = {
  "postgres-mcp": { label: "PostgreSQL", description: "Direct DB query execution, migrations and schema inspection." },
  "github-mcp": { label: "GitHub", description: "Branch management, pull requests and commit checks." },
  "web-search": {
    label: "Web Search",
    description: "Search the web mid-run (Brave/Tavily/Exa/SearXNG) with the account's own configured key, proxied by the host so the key never enters the VM.",
  },
  "locator": {
    label: "Code Locator",
    description: "Ripgrep-backed symbol/concept search over the workspace: returns ranked file:line matches with snippets.",
  },
  "computer-mcp": {
    label: "Desktop Computer",
    description: "Control the on-screen desktop: screenshots, clicks, typing, keys, scrolling and opening apps (desktop VM mode only).",
  },
  "playwright-mcp": {
    label: "Desktop Browser",
    description: "Drive the visible on-screen Chromium: navigation, clicks, typing and page snapshots (desktop VM mode only).",
  },
};

// Skill ids roles can reference. These mirror the app's MCP skill catalog
// (minimalist-ui/src/data.ts DEFAULT_MCP_SKILLS).
export const ROLE_SKILL_REGISTRY: Readonly<Record<string, { label: string; description: string }>> = {
  "terminal-exec": { label: "Bash & Terminal", description: "Executes shell commands, git and build runners in the VM." },
  "browser-live": { label: "Live Headed Browser", description: "Interactive browser session streamed into the dashboard." },
  "file-editor": { label: "Surgical File Editor", description: "Atomic file reading, writing and diff-based patching." },
};

// ---- Long-running work guidance (system prompt tail) ----

/**
 * Appended to every role's system prompt by rolePhase (see
 * ./harness/role-mcp): work the user asked to watch must stay in the
 * foreground so its output streams into the terminal and the run stays
 * active (and stoppable) until it finishes. Backgrounding a loop the user
 * asked to see — e.g. counting to 200 with `sleep 1` detached via `&` —
 * ends the run while the work is still running unseen, so the terminal
 * never shows the numbers and the user cannot stop it. A single shared
 * tail keeps built-in and custom roles on the same rule.
 */
export const LONG_RUNNING_WORK_TAIL =
  "Long-running work stays visible. Run work the user asked to watch in the foreground so its output streams " +
  "into the terminal — never background it with `&`, `nohup`, `setsid`, `disown`, or a detached tmux/screen session. " +
  "Keep the run active until the work finishes so the user can watch or stop it, and never end your reply with " +
  "\"it'll take about N minutes\" while the work is still running unseen. If something genuinely must run in the " +
  "background (a server, or a job the user asked to leave running), say so plainly, report its PID and log file path, " +
  "and keep tailing the log in the foreground until it finishes or the user stops it.";

export const BUILTIN_ROLES: readonly RoleDefinition[] = [
  {
    id: "main",
    name: "A1",
    description: "The generalist default: plans, codes, browses, runs checks, and switches roles when specialization helps.",
    glyph: "★",
    model: "",
    permissions: permissions({ allowBash: true, allowWrite: true, allowNetwork: true, allowBrowser: true, allowSubagents: true }),
    tools: ["plan", "read_file", "search", "write_file", "edit_file", "restore_checkpoint", "bash", "web_search", "web_fetch", "browser", "api_request", "subagent", "dispatch_explorer"],
    mcpServers: ["github-mcp"],
    skills: ["terminal-exec", "file-editor", "browser-live"],
    instructions:
      "You are A1. You are the generalist default: plan the work, code, run checks, browse when needed, and delegate when a specialist is better. You can switch roles yourself with set_role when a task calls for a specialist, and list_roles to see what is available. Never claim verification you did not perform.",
    category: "core",
    builtin: true,
  },
  {
    id: "orchestrator",
    name: "Orchestrator",
    description: "Splits a goal into independent work, delegates it to the right roles, and reconciles the reports.",
    glyph: "◎",
    model: "",
    permissions: permissions({ allowNetwork: true, allowSubagents: true }),
    tools: ["plan", "read_file", "search", "web_search", "web_fetch", "subagent", "dispatch_explorer"],
    mcpServers: [],
    skills: ["terminal-exec"],
    instructions:
      "You are the orchestrator. Keep one explicit plan, split the goal into independent pieces, and delegate each piece with a self-contained brief. Do not do work that a specialist can do. Reconcile the reports yourself: verify claims against files, commands and URLs, resolve conflicts, and state clearly what is verified, what is assumed, and what is unfinished.",
    category: "core",
    builtin: true,
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Gathers evidence from the codebase and the web, then reports exact sources and findings.",
    glyph: "⌕",
    model: "",
    permissions: permissions({ readOnly: true, allowNetwork: true, allowBrowser: true }),
    tools: ["read_file", "search", "web_search", "web_fetch", "browser", "dispatch_explorer"],
    mcpServers: ["web-search"],
    skills: ["browser-live"],
    instructions:
      "You are a researcher. Answer the question with evidence, not guesses. Prefer primary sources and the live codebase. Give exact paths, line numbers, URLs and quoted evidence. Separate verified facts from inference, note what you could not determine, and do not modify files.",
    category: "research",
    builtin: true,
  },
  {
    id: "implementer",
    name: "Implementer",
    description: "Owns a change end-to-end: inspect, edit, run the checks, and report exactly what changed.",
    glyph: "⚒",
    model: "",
    lens: "security",
    permissions: permissions({ allowBash: true, allowWrite: true, allowNetwork: true }),
    tools: ["read_file", "search", "write_file", "edit_file", "restore_checkpoint", "bash"],
    mcpServers: [],
    skills: ["terminal-exec", "file-editor"],
    instructions:
      "You are an implementer. Inspect the existing code before editing, make the smallest coherent change that solves the task, and follow the surrounding style. Run the relevant tests, typecheck or build before reporting. Never claim verification you did not perform. Report files changed, commands run, results, and anything left undone.",
    category: "build",
    builtin: true,
  },
  {
    id: "frontend-engineer",
    name: "Frontend Engineer",
    description: "Builds UI: components, styling, accessibility, responsive layout, and frontend tests.",
    glyph: "◈",
    model: "",
    permissions: permissions({ allowBash: true, allowWrite: true, allowNetwork: true, allowBrowser: true }),
    tools: ["read_file", "search", "write_file", "edit_file", "restore_checkpoint", "bash", "web_fetch", "browser"],
    mcpServers: ["github-mcp"],
    skills: ["terminal-exec", "file-editor", "browser-live"],
    instructions:
      "You are a frontend engineer. Work in the smallest components that keep the UI coherent, match the project's design language, and keep accessibility in mind (semantic markup, focus, contrast). Verify visually in the browser when you can, run the frontend tests and build before reporting, and report exactly what changed.",
    category: "build",
    builtin: true,
  },
  {
    id: "backend-engineer",
    name: "Backend Engineer",
    description: "Builds APIs, data layers and services with correctness, migrations and performance in mind.",
    glyph: "▤",
    model: "",
    permissions: permissions({ allowBash: true, allowWrite: true, allowNetwork: true }),
    tools: ["read_file", "search", "write_file", "edit_file", "restore_checkpoint", "bash", "api_request", "web_fetch"],
    mcpServers: ["postgres-mcp"],
    skills: ["terminal-exec", "file-editor"],
    instructions:
      "You are a backend engineer. Prefer small, typed, testable units. Consider data shape, edge cases, error handling and performance before editing. Run the relevant tests and typecheck, and report behavior changes, migration steps and anything you did not verify.",
    category: "build",
    builtin: true,
  },
  {
    id: "debugger",
    name: "Debugger",
    description: "Reproduces failures, isolates root causes, and applies the smallest fix with verification.",
    glyph: "⚡",
    model: "",
    permissions: permissions({ allowBash: true, allowWrite: true }),
    tools: ["read_file", "search", "bash", "write_file", "edit_file", "restore_checkpoint"],
    mcpServers: [],
    skills: ["terminal-exec", "file-editor"],
    instructions:
      "You are a debugger. Reproduce the failure first, then isolate the root cause with the narrowest evidence (logs, tracebacks, minimal cases). Apply the smallest fix that addresses the cause, and re-run the failing check plus neighbors before reporting. State what you ruled out.",
    category: "build",
    builtin: true,
  },
  {
    id: "auditor",
    name: "Auditor",
    description: "Adversarial reviewer for correctness, security, performance and regressions.",
    glyph: "✓",
    model: "",
    permissions: permissions({ readOnly: true, allowBash: true }),
    tools: ["read_file", "search", "bash"],
    mcpServers: [],
    skills: ["terminal-exec"],
    instructions:
      "You are an auditor. Review the work adversarially for correctness, security, performance, accessibility and regressions. Run read-only checks or the test suite when useful, but do not edit files. Report findings by severity with exact file:line references, concrete evidence and a suggested fix. If a claim cannot be verified, say so.",
    category: "quality",
    builtin: true,
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Reviews diffs for correctness, style and maintainability, and suggests concrete fixes.",
    glyph: "↻",
    model: "",
    permissions: permissions({ readOnly: true, allowBash: true }),
    tools: ["read_file", "search", "bash"],
    mcpServers: ["github-mcp"],
    skills: ["terminal-exec"],
    instructions:
      "You are a code reviewer. Read diffs in context, not in isolation. Check correctness, error handling, style consistency, tests and maintainability. Comment on the code, not the author, and always pair a concern with a concrete suggestion. Do not edit files.",
    category: "quality",
    builtin: true,
  },
  {
    id: "test-writer",
    name: "Test Writer",
    description: "Writes and runs tests that cover behavior, edge cases and regressions.",
    glyph: "⌬",
    model: "",
    permissions: permissions({ allowBash: true, allowWrite: true }),
    tools: ["read_file", "search", "write_file", "edit_file", "bash"],
    mcpServers: [],
    skills: ["terminal-exec", "file-editor"],
    instructions:
      "You are a test writer. Test observable behavior, not implementation details. Cover the happy path, edge cases and failure modes, and keep tests fast and focused. Run the suite for the area you touched and report which tests pass, which fail, and overall coverage gaps.",
    category: "quality",
    builtin: true,
  },
  {
    id: "security-auditor",
    name: "Security Auditor",
    description: "Looks for vulnerabilities and hardening gaps: secrets, injection, auth, supply chain.",
    glyph: "⛨",
    model: "",
    permissions: permissions({ readOnly: true, allowBash: true, allowNetwork: true }),
    tools: ["read_file", "search", "bash", "web_search", "web_fetch"],
    mcpServers: ["github-mcp"],
    skills: ["terminal-exec"],
    instructions:
      "You are a security auditor. Look for injection, broken auth, secret leakage, insecure defaults, unsafe dependencies and supply-chain risks. Cite exact evidence with file:line and severity. Do not fix; report with a concrete remediation for each finding.",
    category: "quality",
    builtin: true,
  },
  {
    id: "browser-operator",
    name: "Browser Operator",
    description: "Runs QA and web tasks in the live browser: flows, UI checks, evidence.",
    glyph: "◉",
    model: "",
    permissions: permissions({ readOnly: true, allowNetwork: true, allowBrowser: true }),
    tools: ["read_file", "search", "web_search", "web_fetch", "browser"],
    mcpServers: [],
    skills: ["browser-live"],
    instructions:
      "You are a browser operator. Drive the live browser for QA and web tasks: open the app, step through user flows, and verify behavior against expectations. Record concrete evidence (URLs, states, screenshots via the browser tool) and report pass/fail per step. Do not modify files.",
    category: "quality",
    builtin: true,
  },
  {
    id: "devops",
    name: "DevOps",
    description: "Builds, deploys and operates the stack with reproducible commands and a rollback plan.",
    glyph: "⚙",
    model: "",
    permissions: permissions({ allowBash: true, allowWrite: true, allowNetwork: true }),
    tools: ["read_file", "search", "write_file", "edit_file", "bash", "web_fetch", "api_request"],
    mcpServers: ["github-mcp"],
    skills: ["terminal-exec", "file-editor"],
    instructions:
      "You are the DevOps engineer. Inspect the current configuration before changing it, use reproducible commands, keep secrets out of logs and files, and verify health after every deployment. State the rollback path before applying a risky change. Prefer small, reversible steps and report the exact commands and outcomes.",
    category: "ops",
    builtin: true,
  },
  {
    id: "deployer",
    name: "Deployer",
    description: "Ships builds through environments with verification, health checks and rollback readiness.",
    glyph: "▲",
    model: "",
    permissions: permissions({ allowBash: true, allowWrite: true, allowNetwork: true }),
    tools: ["read_file", "search", "write_file", "edit_file", "restore_checkpoint", "bash", "web_fetch", "api_request"],
    mcpServers: ["github-mcp"],
    skills: ["terminal-exec", "file-editor"],
    instructions:
      "You are the deployer. Drive the build and deployment pipeline with reproducible commands, verify each environment after the change, and keep a clear rollback plan. Never put secrets in logs or files. Report the deploy steps, verification results and the rollback path.",
    category: "ops",
    builtin: true,
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    description: "Queries and analyzes data, then reports findings with numbers and charts.",
    glyph: "▦",
    model: "",
    permissions: permissions({ readOnly: true, allowBash: true, allowNetwork: true }),
    tools: ["read_file", "search", "bash", "web_search", "web_fetch"],
    mcpServers: ["postgres-mcp"],
    skills: ["terminal-exec"],
    instructions:
      "You are a data analyst. Start from a clear question, use reproducible queries, and report numbers with their source and method. Distinguish observed facts from assumptions, note data limitations, and do not modify files.",
    category: "research",
    builtin: true,
  },
  {
    id: "technical-writer",
    name: "Technical Writer",
    description: "Writes and improves docs that are accurate to the code and useful to the reader.",
    glyph: "✎",
    model: "",
    permissions: permissions({ allowBash: true, allowWrite: true }),
    tools: ["read_file", "search", "write_file", "edit_file", "bash"],
    mcpServers: [],
    skills: ["terminal-exec", "file-editor"],
    instructions:
      "You are a technical writer. Verify claims against the code before writing them. Prefer short sentences, concrete examples and correct command snippets. Do not change code behavior — docs only. Report which files you edited and what you verified against.",
    category: "research",
    builtin: true,
  },
  {
    id: "product-designer",
    name: "Product Designer",
    description: "Critiques UX and UI against goals: hierarchy, clarity, accessibility, motion.",
    glyph: "✦",
    model: "",
    permissions: permissions({ readOnly: true, allowBrowser: true }),
    tools: ["read_file", "search", "browser", "web_fetch"],
    mcpServers: [],
    skills: ["browser-live"],
    instructions:
      "You are a product designer. Evaluate the UI against the user's goals: visual hierarchy, clarity, consistency, accessibility and motion. Look at the real product in the browser and cite concrete observations. Recommend changes; do not implement them or edit files.",
    category: "research",
    builtin: true,
  },
];

export const BUILTIN_ROLE_IDS: ReadonlySet<string> = new Set(BUILTIN_ROLES.map((role) => role.id));

// ---- Model suggestions ----

export interface RoleModelOption {
  id: string;
  label: string;
}

/**
 * Fallbacks for the model picker when the app cannot list the user's actual
 * connections. Provider connections are preferred and shown first.
 */
export const DEFAULT_ROLE_MODELS: readonly RoleModelOption[] = [
  { id: "claude-opus-4-1", label: "Claude Opus 4.1 · Anthropic" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5 · Anthropic" },
  { id: "gpt-5", label: "GPT-5 · OpenAI" },
  { id: "gpt-5-mini", label: "GPT-5 mini · OpenAI" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro · Google" },
  { id: "grok-4", label: "Grok 4 · xAI" },
  { id: "deepseek-chat", label: "DeepSeek Chat · DeepSeek" },
];

// ---- Validation / normalisation ----

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asText = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

const asBool = (value: unknown, fallback = false): boolean => (typeof value === "boolean" ? value : fallback);

/** Turn a display name into a stable, URL-safe id. */
export function slugifyRoleId(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug || "role";
}

/** A non-built-in id that is unique among `taken`, suffixed with -2, -3, … when needed. */
export function uniqueRoleId(preferred: string, taken: Iterable<string>): string {
  const used = new Set<string>(taken);
  const base = slugifyRoleId(preferred);
  if (!used.has(base) && !BUILTIN_ROLE_IDS.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate) && !BUILTIN_ROLE_IDS.has(candidate)) return candidate;
  }
}

export function normalizePermissions(raw: unknown): RolePermissions {
  const r = asRecord(raw) ?? {};
  const readOnly = asBool(r.readOnly);
  return {
    readOnly,
    allowBash: asBool(r.allowBash),
    // read-only and write are mutually exclusive; read-only wins.
    allowWrite: readOnly ? false : asBool(r.allowWrite),
    allowNetwork: asBool(r.allowNetwork),
    allowBrowser: asBool(r.allowBrowser),
    allowSubagents: asBool(r.allowSubagents),
  };
}

/** Keep valid string ids (tool/MCP/skill ids), drop junk and duplicates. */
function normalizeStringList(raw: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim().slice(0, maxLen);
    if (name && /^[A-Za-z0-9_.:-]+$/.test(name)) seen.add(name);
  }
  return [...seen].slice(0, maxItems);
}

/** Keep valid tool ids (including MCP/imported names), drop junk and duplicates. */
export function normalizeTools(raw: unknown): string[] {
  return normalizeStringList(raw, 64, 80);
}

/** Keep valid MCP server ids (registry or imported names), drop junk and duplicates. */
export function normalizeMcpServers(raw: unknown): string[] {
  return normalizeStringList(raw, 16, 60);
}

/** Keep valid skill ids, drop junk and duplicates. */
export function normalizeSkills(raw: unknown): string[] {
  return normalizeStringList(raw, 16, 60);
}

/** Map any input onto a known category; unknown values fall back to "core". */
export function normalizeCategory(raw: unknown): RoleCategory {
  if (typeof raw === "string" && ROLE_CATEGORY_BY_ID.has(raw as RoleCategory)) {
    return raw as RoleCategory;
  }
  return "core";
}

/**
 * Defensive parse of anything that claims to be a role (hand-edited JSON,
 * localStorage, an import). Returns null when there is no usable name.
 * Imported roles are always custom so they can never shadow a built-in.
 * v1 roles (no category/mcpServers/skills) migrate to v2 defaults here.
 */
export function normalizeRoleDefinition(raw: unknown): RoleDefinition | null {
  const r = asRecord(raw);
  if (!r) return null;
  const name = asText(r.name, 60) || asText(r.label, 60);
  if (!name) return null;
  const glyphSource = asText(r.glyph, 8);
  const glyph = Array.from(glyphSource).slice(0, 2).join("") || "◇";
  return {
    id: asText(r.id, 64) || slugifyRoleId(name),
    name,
    description: asText(r.description, 280),
    glyph,
    model: asText(r.model, 200),
    permissions: normalizePermissions(r.permissions),
    tools: normalizeTools(r.tools),
    mcpServers: normalizeMcpServers(r.mcpServers),
    skills: normalizeSkills(r.skills),
    instructions: asText(r.instructions, 4000),
    category: normalizeCategory(r.category),
    builtin: false,
    ...(isLensId(r.lens) ? { lens: r.lens } : {}),
  };
}

/**
 * A role's full catalog for a run: every built-in plus the signed-in user's
 * custom roles. Custom roles always win over a same-id built-in? No — built-in
 * ids are protected by parse/merge, so customs can never shadow them.
 */
export function catalogForRoles(customRoles: readonly RoleDefinition[] = []): RoleDefinition[] {
  return [...BUILTIN_ROLES, ...customRoles.filter((role) => !role.builtin && !BUILTIN_ROLE_IDS.has(role.id))];
}

// ---- Per-run role policy (no privilege escalation) ----
//
// A run starts under one role. The agent may switch only to roles the user
// granted for that run: by default the starting role plus every role whose
// capabilities (permissions, tools and MCP servers) are a subset of the
// starting role's. Anything broader is an escalation: it needs an explicit
// user grant (pre-granted in the composer, or approved at runtime through the
// approval gateway). The set is always intersected with the user's catalog, so
// a run can never exceed the roles the user actually has.

export interface RoleCapabilityDelta {
  /** Permission keys the target enables that the baseline did not. */
  addedPermissions: PermissionKey[];
  /** Tool ids the target may call that the baseline could not. */
  addedTools: string[];
  /** MCP server ids the target may use that the baseline could not. */
  addedMcpServers: string[];
}

/**
 * What `to` can do that `from` cannot. Used to decide whether a role switch is
 * an escalation: an empty delta means the target is within the baseline's
 * capabilities and is safe to switch to without asking the user.
 *
 * `readOnly` is a restriction, so removing it (true -> false) *adds* write
 * capability and is reported in `addedPermissions`.
 */
export function roleCapabilityDelta(from: RoleDefinition, to: RoleDefinition): RoleCapabilityDelta {
  const addedPermissions: PermissionKey[] = [];
  if (from.permissions.readOnly && !to.permissions.readOnly) addedPermissions.push("readOnly");
  for (const key of PERMISSION_KEYS) {
    if (key === "readOnly") continue;
    if (!from.permissions[key] && to.permissions[key]) addedPermissions.push(key);
  }
  const fromTools = new Set(from.tools);
  const addedTools = to.tools.filter((tool) => !fromTools.has(tool));
  const fromMcp = new Set(from.mcpServers);
  const addedMcpServers = to.mcpServers.filter((server) => !fromMcp.has(server));
  return { addedPermissions, addedTools, addedMcpServers };
}

/** True when `candidate` adds no permission, tool or MCP server over `base`. */
export function isRoleWithinRole(candidate: RoleDefinition, base: RoleDefinition): boolean {
  const delta = roleCapabilityDelta(base, candidate);
  return (
    delta.addedPermissions.length === 0 &&
    delta.addedTools.length === 0 &&
    delta.addedMcpServers.length === 0
  );
}

/** True when a capability delta contains anything at all. */
export function hasRoleEscalation(delta: RoleCapabilityDelta): boolean {
  return (
    delta.addedPermissions.length > 0 ||
    delta.addedTools.length > 0 ||
    delta.addedMcpServers.length > 0
  );
}

/** A role's capabilities in one short, human-readable list (approvals, UI). */
export function capabilityDeltaLabels(delta: RoleCapabilityDelta): string[] {
  const labels: string[] = [];
  for (const key of delta.addedPermissions) {
    if (key === "readOnly") labels.push("write access (read-only removed)");
    else labels.push(PERMISSIONS.find((permission) => permission.key === key)?.label ?? key);
  }
  for (const tool of delta.addedTools) labels.push(toolLabel(tool));
  for (const server of delta.addedMcpServers) {
    labels.push(`${ROLE_MCP_SERVER_REGISTRY[server]?.label ?? server} MCP`);
  }
  return labels;
}

/**
 * The explicit role policy stored on a run. Built once when the run starts and
 * never widened behind the user's back: an escalation approval adds its role
 * to `allowedRoleIds` at runtime (the user just approved it), but a role the
 * user never granted is never silently admitted.
 */
export interface RunRolePolicy {
  /** The role the run started under; its capabilities are the baseline. */
  startingRole: RoleDefinition;
  /** Roles this run may switch to without another approval. */
  allowedRoleIds: string[];
  /** Roles the user explicitly pre-granted for this run. */
  grantedRoleIds: string[];
}

/**
 * Build the per-run role policy. `grantedRoleIds` is the user's explicit
 * pre-grant list from the composer; ids missing from the catalog are ignored,
 * so a client can never grant a role the user does not own.
 */
export function buildRunRolePolicy(
  catalog: readonly RoleDefinition[],
  startingRole: RoleDefinition,
  grantedRoleIds: readonly string[] = [],
): RunRolePolicy {
  const allowed = new Set<string>();
  const catalogIds = new Set(catalog.map((role) => role.id));
  if (catalogIds.has(startingRole.id)) allowed.add(startingRole.id);
  // Default: the starting role plus every role that is a subset of it.
  for (const role of catalog) {
    if (role.id === startingRole.id || isRoleWithinRole(role, startingRole)) allowed.add(role.id);
  }
  const granted: string[] = [];
  for (const raw of grantedRoleIds) {
    if (typeof raw !== "string") continue;
    const id = raw.trim().slice(0, 64);
    if (!id || granted.includes(id) || !catalogIds.has(id)) continue;
    granted.push(id);
    allowed.add(id);
  }
  return { startingRole, allowedRoleIds: [...allowed], grantedRoleIds: granted };
}

/**
 * The ids an agent may switch to by default under `startingRole`: the starting
 * role plus every role whose capabilities are a subset of it. With no explicit
 * starting role (legacy callers) the catalog's A1 is the baseline.
 */
export function defaultAllowedRoleIds(
  catalog: readonly RoleDefinition[],
  startingRole?: RoleDefinition,
): ReadonlySet<string> {
  const baseline =
    startingRole ?? catalog.find((role) => role.id === DEFAULT_ROLE_ID) ?? catalog[0];
  if (!baseline) return new Set<string>();
  return new Set(buildRunRolePolicy(catalog, baseline).allowedRoleIds);
}

/** The desktop MCP server ids (computer-mcp + playwright-mcp). */
export const DESKTOP_ROLE_MCP_SERVERS: readonly string[] = ["computer-mcp", "playwright-mcp"];

/**
 * Does a role have desktop access (i.e. may it be wired the desktop MCP
 * servers in desktop VM mode)?
 *
 * Built-in roles get the servers when they have browser access
 * (`allowBrowser` — A1 and the browser/research roles). Custom
 * roles must opt in by listing a desktop MCP server in `mcpServers`, so the
 * harness never exceeds the user's own settings for a custom role.
 */
export function roleHasDesktopAccess(role: RoleDefinition): boolean {
  if (!role.permissions.allowBrowser) return false;
  if (role.builtin) return true;
  return role.mcpServers.some((id) => DESKTOP_ROLE_MCP_SERVERS.includes(id));
}

// ---- Role-switch validation (shared by the harness and the MCP server) ----

export type RoleSwitchError = "unknown_role" | "not_allowed";

export type RoleSwitchDecision =
  | { ok: true; role: RoleDefinition }
  | { ok: false; error: RoleSwitchError; requestedId: string };

/**
 * Validate an agent-requested role switch against the user's catalog and
 * policy. The agent can never switch to a role outside the user's allowed set
 * (that is the "cannot escalate" guarantee), and unknown ids are rejected.
 */
export function resolveRoleSwitch(
  catalog: readonly RoleDefinition[],
  allowedRoleIds: ReadonlySet<string>,
  roleId: string,
): RoleSwitchDecision {
  const requested = typeof roleId === "string" ? roleId.trim() : "";
  if (!requested) return { ok: false, error: "unknown_role", requestedId: roleId };
  const role = catalog.find((candidate) => candidate.id === requested);
  if (!role) return { ok: false, error: "unknown_role", requestedId: roleId };
  if (!allowedRoleIds.has(requested)) return { ok: false, error: "not_allowed", requestedId: roleId };
  return { ok: true, role };
}

// ---- Import / export ----

export interface RoleBundle {
  schema: string;
  version: number;
  exportedAt: string;
  roles: RoleDefinition[];
}

export interface RoleParseResult {
  roles: RoleDefinition[];
  errors: string[];
}

/** A self-describing bundle of custom roles, safe to download or store. */
export function createRoleBundle(roles: readonly RoleDefinition[]): RoleBundle {
  return {
    schema: ROLE_SCHEMA,
    version: ROLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    roles: roles
      .filter((role) => !role.builtin)
      .map((role) => ({
        ...role,
        builtin: false,
        permissions: { ...role.permissions },
        tools: [...role.tools],
        mcpServers: [...role.mcpServers],
        skills: [...role.skills],
      })),
  };
}

/** Parse a downloaded role bundle. Accepts a bare array too, for hand-written files. */
export function parseRoleBundle(text: string): RoleParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { roles: [], errors: ["That file isn't valid JSON."] };
  }
  return parseRoleData(data);
}

export function parseRoleData(data: unknown): RoleParseResult {
  const errors: string[] = [];
  let rawRoles: unknown[];
  if (Array.isArray(data)) {
    rawRoles = data;
  } else {
    const bundle = asRecord(data);
    if (!bundle) return { roles: [], errors: ["Expected a JSON array of roles or a bundle with a roles array."] };
    if (typeof bundle.schema === "string" && bundle.schema !== ROLE_SCHEMA) {
      return { roles: [], errors: [`This isn't a SwarmAgents role bundle (schema "${bundle.schema}").`] };
    }
    if (typeof bundle.version === "number" && bundle.version > ROLE_SCHEMA_VERSION) {
      return { roles: [], errors: ["This role bundle was made by a newer version of SwarmAgents."] };
    }
    if (!Array.isArray(bundle.roles)) return { roles: [], errors: ["The bundle has no roles array."] };
    rawRoles = bundle.roles;
  }

  if (rawRoles.length > 100) errors.push("Only the first 100 roles in the file were read.");
  const byId = new Map<string, RoleDefinition>();
  rawRoles.slice(0, 100).forEach((item, index) => {
    const role = normalizeRoleDefinition(item);
    if (!role) {
      errors.push(`Role ${index + 1}: needs a name.`);
      return;
    }
    if (BUILTIN_ROLE_IDS.has(role.id)) {
      errors.push(`"${role.name}" uses the built-in id "${role.id}" and was skipped.`);
      return;
    }
    if (byId.has(role.id)) errors.push(`"${role.name}" repeats id "${role.id}"; the later copy wins.`);
    byId.set(role.id, { ...role, builtin: false });
  });
  return { roles: [...byId.values()], errors };
}

/** Replace same-id custom roles and append the rest, preserving existing order. */
export function mergeCustomRoles(existing: readonly RoleDefinition[], incoming: readonly RoleDefinition[]): RoleDefinition[] {
  const merged = new Map(existing.filter((role) => !role.builtin).map((role) => [role.id, role] as const));
  for (const role of incoming) if (!role.builtin && !BUILTIN_ROLE_IDS.has(role.id)) merged.set(role.id, role);
  return [...merged.values()];
}

// ---- Local persistence ----

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Private mode / blocked storage: the catalog still works in memory.
    return null;
  }
}

export function loadCustomRoles(key = ROLES_STORAGE_KEY, store: KeyValueStore | null = browserStore()): RoleDefinition[] {
  if (!store) return [];
  try {
    const raw = store.getItem(key);
    if (!raw) return [];
    return parseRoleData(JSON.parse(raw)).roles;
  } catch {
    return [];
  }
}

export function saveCustomRoles(roles: readonly RoleDefinition[], key = ROLES_STORAGE_KEY, store: KeyValueStore | null = browserStore()): void {
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(createRoleBundle(roles)));
  } catch {
    // Quota or blocked storage: keep the in-memory catalog, don't break the UI.
  }
}

// ---- Display helpers ----

/** Short chips for a role card, e.g. ["read-only", "shell"]. */
export function permissionLabels(rolePermissions: RolePermissions): string[] {
  const out: string[] = [];
  if (rolePermissions.readOnly) out.push("read-only");
  if (rolePermissions.allowBash) out.push("shell");
  if (rolePermissions.allowWrite) out.push("write");
  if (rolePermissions.allowNetwork) out.push("network");
  if (rolePermissions.allowBrowser) out.push("browser");
  if (rolePermissions.allowSubagents) out.push("sub-agents");
  return out;
}

/** One line for a picker: the model id or the workspace default. */
export function roleModelLabel(model: string): string {
  return model.trim() || "Workspace default";
}

/** Category label for a role id, e.g. "Build". */
export function roleCategoryLabel(category: RoleCategory): string {
  return ROLE_CATEGORY_BY_ID.get(category)?.label ?? "Core";
}

