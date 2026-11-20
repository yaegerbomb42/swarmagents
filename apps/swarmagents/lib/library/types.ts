/**
 * Shapes for the per-account Library and its shared public catalog.
 *
 * A Library item is one capability the user can give their agent: a skill
 * (SKILL.md + optional supporting files), a custom tool, or an MCP server.
 * "connector" is an MCP server that came from the verified connector catalog;
 * it installs with the same payload shape as "mcp".
 *
 * Everything here is dependency-free so route handlers, the runtime and the
 * browser can share the same types. Secret *values* never appear in these
 * types: a published payload carries only `requiredFields` metadata (the
 * installer supplies the values into their own account), which is what makes
 * "publishing never leaks the publisher's secrets" enforceable in the type
 * system as well as at runtime.
 */

export const LIBRARY_SCHEMA = "swarmagents.library";
export const LIBRARY_SCHEMA_VERSION = 1;

export const LIBRARY_KINDS = ["skill", "tool", "mcp", "connector"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export const LIBRARY_KIND_LABELS: Readonly<Record<LibraryKind, string>> = {
  skill: "Skill",
  tool: "Tool",
  mcp: "MCP server",
  connector: "Connector",
};

export function isLibraryKind(value: unknown): value is LibraryKind {
  return typeof value === "string" && (LIBRARY_KINDS as readonly string[]).includes(value);
}

/** Moderation state of a public item. New submissions start "unreviewed". */
export type ModerationState = "unreviewed" | "reviewed" | "unpublished";

/** A required input the installer must supply; never a value. */
export interface SecretField {
  key: string;
  label: string;
  helpUrl?: string;
}

export interface SkillFile {
  /** Path relative to the skill directory. */
  path: string;
  content: string;
}

export interface SkillPayload {
  kind: "skill";
  skillMd: string;
  files: SkillFile[];
  requiredFields: SecretField[];
}

export interface ToolPayload {
  kind: "tool";
  language: "javascript";
  code: string;
  /** JSON Schema for the tool input (shown in the installer's preview). */
  inputSchema: Record<string, unknown>;
  requiredFields: SecretField[];
  timeoutMs: number;
}

export interface McpPayload {
  kind: "mcp" | "connector";
  transport: "stdio" | "http";
  /** HTTP endpoint (transport "http"). */
  url?: string;
  /** Executable (transport "stdio"). */
  command?: string;
  args?: string[];
  /** Field names the installer must fill; values are sealed in their account. */
  requiredFields: SecretField[];
  /** Optional connector-catalog tool names, for display only. */
  tools?: string[];
}

export type LibraryPayload = SkillPayload | ToolPayload | McpPayload;

export function payloadSecretFields(payload: LibraryPayload): SecretField[] {
  return payload.requiredFields;
}

/** Deep copy of a payload (install must copy, never share a reference). */
export function clonePayload<T extends LibraryPayload>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T;
}

export const LIMITS = {
  name: 120,
  description: 4000,
  license: 80,
  authorHandle: 80,
  skillMd: 64 * 1024,
  skillFile: 32 * 1024,
  skillFiles: 20,
  code: 64 * 1024,
  command: 500,
  url: 2048,
  args: 32,
  arg: 500,
  secretKey: 64,
  secretLabel: 120,
  secretValue: 4096,
  reason: 500,
  handle: 80,
} as const;

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** A rejected library mutation. `status` is the HTTP status the route should use. */
export class LibraryError extends Error {
  readonly status: number;
  /** Extra structured detail (e.g. the missing required fields). */
  readonly details?: Record<string, unknown>;

  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "LibraryError";
    this.status = status;
    this.details = details;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown, field: string, max: number, required = true): string {
  if (value === undefined || value === null) {
    if (!required) return "";
    throw new LibraryError(`${field} is required.`);
  }
  if (typeof value !== "string") throw new LibraryError(`${field} must be a string.`);
  const out = value.trim();
  if (!out) {
    if (!required) return "";
    throw new LibraryError(`${field} is required.`);
  }
  if (out.length > max) throw new LibraryError(`${field} must be at most ${max} characters.`);
  return out;
}

/** Reject a path that could escape the skill directory or the workspace. */
export function assertSafeRelativePath(value: unknown, field = "file path"): string {
  if (typeof value !== "string") throw new LibraryError(`${field} must be a string.`);
  const path = value.trim().replace(/^\.\//, "");
  if (!path || path.length > 200) throw new LibraryError(`${field} must be 1-200 characters.`);
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new LibraryError(`${field} contains a control character.`);
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw new LibraryError(`${field} must be relative.`);
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new LibraryError(`${field} must not contain empty, "." or ".." segments.`);
  }
  return parts.join("/");
}

function normalizeSecretFields(value: unknown): SecretField[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new LibraryError("requiredFields must be an array.");
  if (value.length > 16) throw new LibraryError("At most 16 required fields are supported.");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new LibraryError(`requiredFields[${index}] must be an object.`);
    const key = trimmed(raw.key, `requiredFields[${index}].key`, LIMITS.secretKey);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new LibraryError(`requiredFields[${index}].key must be an env-style name.`);
    }
    if (seen.has(key)) throw new LibraryError(`Duplicate required field "${key}".`);
    seen.add(key);
    const label = raw.label === undefined ? key : trimmed(raw.label, `requiredFields[${index}].label`, LIMITS.secretLabel);
    let helpUrl: string | undefined;
    if (raw.helpUrl !== undefined && raw.helpUrl !== null && raw.helpUrl !== "") {
      helpUrl = trimmed(raw.helpUrl, `requiredFields[${index}].helpUrl`, LIMITS.url);
      let parsed: URL;
      try {
        parsed = new URL(helpUrl);
      } catch {
        throw new LibraryError(`requiredFields[${index}].helpUrl must be a URL.`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new LibraryError(`requiredFields[${index}].helpUrl must be http(s).`);
      }
    }
    return helpUrl ? { key, label, helpUrl } : { key, label };
  });
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return { type: "object", properties: {} };
  if (!isRecord(value)) throw new LibraryError("inputSchema must be an object.");
  const serialized = JSON.stringify(value);
  if (serialized.length > LIMITS.code) throw new LibraryError("inputSchema is too large.");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function normalizeSkillFiles(value: unknown): SkillFile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new LibraryError("files must be an array.");
  if (value.length > LIMITS.skillFiles) throw new LibraryError(`At most ${LIMITS.skillFiles} files are supported.`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new LibraryError(`files[${index}] must be an object.`);
    const path = assertSafeRelativePath(raw.path, `files[${index}].path`);
    if (seen.has(path)) throw new LibraryError(`Duplicate file "${path}".`);
    seen.add(path);
    if (typeof raw.content !== "string") throw new LibraryError(`files[${index}].content must be a string.`);
    if (new TextEncoder().encode(raw.content).length > LIMITS.skillFile) {
      throw new LibraryError(`files[${index}].content is too large.`);
    }
    return { path, content: raw.content };
  });
}

/**
 * Validate and normalize a published/installed payload. `kind` is used to
 * reject payloads that do not match their item kind, so a "skill" can never
 * smuggle executable tool code through an untyped object.
 */
export function normalizePayload(kind: LibraryKind, value: unknown): LibraryPayload {
  if (!isRecord(value)) throw new LibraryError("payload must be an object.");
  const declared = value.kind;
  if (declared !== undefined && declared !== kind) {
    throw new LibraryError("payload.kind must match the item kind.");
  }
  if (kind === "skill") {
    const skillMd = trimmed(value.skillMd, "payload.skillMd", LIMITS.skillMd);
    return {
      kind: "skill",
      skillMd,
      files: normalizeSkillFiles(value.files),
      requiredFields: normalizeSecretFields(value.requiredFields),
    };
  }
  if (kind === "tool") {
    const language = value.language === undefined ? "javascript" : value.language;
    if (language !== "javascript") throw new LibraryError('payload.language must be "javascript".');
    const code = trimmed(value.code, "payload.code", LIMITS.code);
    const timeoutRaw = value.timeoutMs === undefined ? DEFAULT_TOOL_TIMEOUT_MS : value.timeoutMs;
    if (typeof timeoutRaw !== "number" || !Number.isFinite(timeoutRaw) || timeoutRaw < 1_000 || timeoutRaw > 120_000) {
      throw new LibraryError("payload.timeoutMs must be between 1000 and 120000.");
    }
    return {
      kind: "tool",
      language: "javascript",
      code,
      inputSchema: normalizeInputSchema(value.inputSchema),
      requiredFields: normalizeSecretFields(value.requiredFields),
      timeoutMs: Math.floor(timeoutRaw),
    };
  }
  // mcp / connector
  const transport = value.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new LibraryError('payload.transport must be "stdio" or "http".');
  }
  const requiredFields = normalizeSecretFields(value.requiredFields);
  let tools: string[] | undefined;
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > 200) throw new LibraryError("payload.tools must be an array.");
    tools = value.tools.map((tool, index) => trimmed(tool, `payload.tools[${index}]`, 200));
  }
  if (transport === "stdio") {
    const command = trimmed(value.command, "payload.command", LIMITS.command);
    let args: string[] = [];
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.length > LIMITS.args) {
        throw new LibraryError(`payload.args must be an array of at most ${LIMITS.args} strings.`);
      }
      args = value.args.map((arg, index) => trimmed(arg, `payload.args[${index}]`, LIMITS.arg));
    }
    return { kind, transport, command, args, requiredFields, ...(tools ? { tools } : {}) };
  }
  const url = trimmed(value.url, "payload.url", LIMITS.url);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LibraryError("payload.url must be a URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new LibraryError("payload.url must be http(s).");
  }
  if (parsed.username || parsed.password) throw new LibraryError("payload.url must not embed credentials.");
  if (value.command !== undefined || value.args !== undefined) {
    throw new LibraryError('A "http" payload cannot also set command/args.');
  }
  return { kind, transport, url, requiredFields, ...(tools ? { tools } : {}) };
}

/** Reject object keys that look like they carry secret material. */
export function assertNoSecretMaterial(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const isSecretContainer = /^(secret|secrets|secretValues|env|headers|authorization)$/i.test(key);
    const isSecretKey = /^(token|password|passwd|api[-_]?key|access[-_]?token|client[-_]?secret)$/i.test(key);
    const carriesValue = typeof entry === "string" ? entry.trim().length > 0 : Array.isArray(entry);
    if (isSecretContainer || (isSecretKey && carriesValue)) {
      throw new LibraryError(
        `${path}.${key} may carry secret material. Publish secret *field names* in requiredFields only; ` +
          "values stay in your own account.",
      );
    }
    assertNoSecretMaterial(entry, `${path}.${key}`);
  }
}
