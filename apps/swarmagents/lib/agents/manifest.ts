/**
 * Universal agent manifest (Agent Studio, phase 1).
 *
 * The manifest is the portable asset: a versioned, machine-readable definition
 * of one agent that can be validated, stored, exported, imported and deployed
 * to *any* harness. It deliberately contains no credentials, no environment
 * bindings and no execution state — see `stripSecrets` and the export route.
 *
 * Validation is strict about anything that would fail at deploy time (unknown
 * model, unknown skill, empty prompt) and lenient about things that only make
 * the deployment weaker (unknown MCP server or connector name, a denied tool
 * that is also allowlisted): those are warnings, not errors.
 */

import { PROVIDER_CATALOG } from "../providers/catalog";

export const AGENT_MANIFEST_VERSION = 1;
export const MAX_NAME = 100;
export const MAX_DESCRIPTION = 500;
export const MAX_SYSTEM_PROMPT = 16_000;
export const MAX_TONE = 200;
export const MAX_FALLBACK_MODELS = 3;
export const MAX_SUBAGENTS = 20;
export const MAX_LIST_ENTRIES = 64;

export type AgentMemoryPolicy = "none" | "session" | "persistent";
export type AgentMcpTransport = "stdio" | "http" | "sse";

export interface AgentMcpServer {
  name: string;
  transport: AgentMcpTransport;
  command?: string;
  url?: string;
  tools?: string[];
}

export interface AgentSubagent {
  name: string;
  instructions: string;
  tools: string[];
  model?: string;
}

export interface AgentManifest {
  version: 1;
  id: string;
  name: string;
  description?: string;
  identity: {
    systemPrompt: string;
    tone?: string;
  };
  models: {
    preferred: string;
    fallbacks: string[];
  };
  tools: string[];
  mcp: AgentMcpServer[];
  connectors: string[];
  context: string[];
  memory: { policy: AgentMemoryPolicy; maxEntries?: number };
  skills: string[];
  workflows: string[];
  policies: {
    maxTurns?: number;
    maxCostUsd?: number;
    requireApprovalFor?: string[];
  };
  permissions: {
    allowTools: string[];
    denyTools: string[];
    approvalRequired: boolean;
  };
  subagents: AgentSubagent[];
}

/**
 * What the destination environment knows about. Every id a manifest names is
 * checked against this; the routes build it per user (their library skills,
 * their connectors) and tests inject a fixed one.
 */
export interface AgentCatalog {
  models: Set<string>;
  skills: Set<string>;
  workflows: Set<string>;
  connectors: Set<string>;
  mcpServers: Set<string>;
}

export interface ManifestValidationOk {
  ok: true;
  manifest: AgentManifest;
  warnings: string[];
}

export interface ManifestValidationFail {
  ok: false;
  errors: string[];
  warnings: string[];
}

export type ManifestValidation = ManifestValidationOk | ManifestValidationFail;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Every model id the provider catalog knows. A manifest may name a bare model
 * id (`claude-sonnet-4-5`) or a `provider/model` pair; both are checked
 * against the catalog rather than a hardcoded list.
 */
export function catalogModelIds(): Set<string> {
  const out = new Set<string>();
  for (const entry of PROVIDER_CATALOG) {
    if (!entry.models) continue;
    if (entry.models.default) out.add(entry.models.default);
    for (const model of entry.models.popular) out.add(model);
  }
  return out;
}

export function isKnownModel(model: string, models: Set<string> = catalogModelIds()): boolean {
  if (typeof model !== "string" || !model.trim()) return false;
  const trimmed = model.trim();
  if (models.has(trimmed)) return true;
  // provider/model form: the model half must still be real.
  const slash = trimmed.indexOf("/");
  return slash > 0 && models.has(trimmed.slice(slash + 1));
}

/** A catalog with no user-specific knowledge (models only). Used as the default. */
export function emptyAgentCatalog(): AgentCatalog {
  return {
    models: catalogModelIds(),
    skills: new Set(),
    workflows: new Set(),
    connectors: new Set(),
    mcpServers: new Set(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function uniqueStrings(value: unknown, max = MAX_LIST_ENTRIES): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeMcp(value: unknown): AgentMcpServer[] {
  if (!Array.isArray(value)) return [];
  const out: AgentMcpServer[] = [];
  for (const raw of value.slice(0, MAX_LIST_ENTRIES)) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name)?.trim();
    const transport = raw.transport;
    if (!name) continue;
    if (transport !== "stdio" && transport !== "http" && transport !== "sse") continue;
    out.push({
      name,
      transport,
      ...(asString(raw.command)?.trim() ? { command: asString(raw.command)!.trim() } : {}),
      ...(asString(raw.url)?.trim() ? { url: asString(raw.url)!.trim() } : {}),
      ...(Array.isArray(raw.tools) ? { tools: uniqueStrings(raw.tools) } : {}),
    });
  }
  return out;
}

function normalizeSubagents(value: unknown): AgentSubagent[] {
  if (!Array.isArray(value)) return [];
  const out: AgentSubagent[] = [];
  for (const raw of value.slice(0, MAX_SUBAGENTS)) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name)?.trim();
    if (!name) continue;
    out.push({
      name,
      instructions: asString(raw.instructions) ?? "",
      tools: uniqueStrings(raw.tools),
      ...(asString(raw.model)?.trim() ? { model: asString(raw.model)!.trim() } : {}),
    });
  }
  return out;
}

/**
 * Validate and normalize an untrusted manifest-shaped value.
 *
 * `catalog` supplies the destination's known ids. The default catalog knows
 * only the provider models, so anything naming skills/workflows/connectors
 * must pass a real one (the routes build it per user).
 */
export interface ValidateOptions {
  /**
   * Check ids against the catalog (skills, workflows, models). Default true for
   * every untrusted input. Reads of already-stored manifests pass `false`: the
   * manifest was validated on write, and a skill removed from the library later
   * must not make the agent unreadable.
   */
  requireCatalogIds?: boolean;
}

export function validateManifest(
  input: unknown,
  catalog: AgentCatalog = emptyAgentCatalog(),
  options: ValidateOptions = {},
): ManifestValidation {
  const strictIds = options.requireCatalogIds !== false;
  const errors: string[] = [];
  const warnings: string[] = [];
  const reject = (message: string) => {
    if (strictIds) errors.push(message);
    else warnings.push(message);
  };

  if (!isRecord(input)) {
    return { ok: false, errors: ["manifest must be a JSON object"], warnings };
  }

  if (input.version !== AGENT_MANIFEST_VERSION) {
    errors.push(`version must be ${AGENT_MANIFEST_VERSION}`);
  }

  const id = asString(input.id)?.trim() ?? "";
  if (!ID_RE.test(id)) {
    errors.push("id must be a slug: lowercase letters, digits and dashes, starting with a letter or digit");
  }

  const name = asString(input.name)?.trim() ?? "";
  if (!name) errors.push("name is required");
  else if (name.length > MAX_NAME) errors.push(`name must be at most ${MAX_NAME} characters`);

  const description = asString(input.description)?.trim();
  if (description && description.length > MAX_DESCRIPTION) {
    errors.push(`description must be at most ${MAX_DESCRIPTION} characters`);
  }

  const identity = isRecord(input.identity) ? input.identity : {};
  const systemPrompt = asString(identity.systemPrompt) ?? "";
  if (!systemPrompt.trim()) errors.push("identity.systemPrompt is required");
  else if (systemPrompt.length > MAX_SYSTEM_PROMPT) {
    errors.push(`identity.systemPrompt must be at most ${MAX_SYSTEM_PROMPT} characters`);
  }
  const tone = asString(identity.tone)?.trim();
  if (tone && tone.length > MAX_TONE) errors.push(`identity.tone must be at most ${MAX_TONE} characters`);

  const models = isRecord(input.models) ? input.models : {};
  const preferred = asString(models.preferred)?.trim() ?? "";
  if (!preferred) errors.push("models.preferred is required");
  else if (!isKnownModel(preferred, catalog.models)) {
    reject(`models.preferred "${preferred}" is not a model in the provider catalog`);
  }
  const fallbacks = uniqueStrings(models.fallbacks, MAX_FALLBACK_MODELS + 1);
  if (fallbacks.length > MAX_FALLBACK_MODELS) {
    errors.push(`models.fallbacks accepts at most ${MAX_FALLBACK_MODELS} models`);
  }
  for (const model of fallbacks) {
    if (!isKnownModel(model, catalog.models)) {
      reject(`models.fallbacks entry "${model}" is not a model in the provider catalog`);
    }
  }

  const tools = uniqueStrings(input.tools);
  const mcp = normalizeMcp(input.mcp);
  const connectors = uniqueStrings(input.connectors);
  const context = uniqueStrings(input.context);
  const skills = uniqueStrings(input.skills);
  const workflows = uniqueStrings(input.workflows);

  for (const server of mcp) {
    if (catalog.mcpServers.size > 0 && !catalog.mcpServers.has(server.name)) {
      warnings.push(`MCP server "${server.name}" is not registered in this environment`);
    }
  }
  for (const connector of connectors) {
    if (catalog.connectors.size > 0 && !catalog.connectors.has(connector)) {
      warnings.push(`connector "${connector}" is not available in this environment`);
    }
  }
  for (const sourceId of context) {
    if (catalog.skills.size > 0 && !catalog.skills.has(sourceId) && !sourceId.includes("/")) {
      warnings.push(`context source "${sourceId}" is not a known skill id or path`);
    }
  }
  for (const skill of skills) {
    if (!catalog.skills.has(skill)) reject(`skill "${skill}" does not exist in the library`);
  }
  for (const workflow of workflows) {
    if (!catalog.workflows.has(workflow)) reject(`workflow "${workflow}" does not exist`);
  }

  const memoryRaw = isRecord(input.memory) ? input.memory : {};
  const policy = memoryRaw.policy;
  const memoryPolicy: AgentMemoryPolicy =
    policy === "none" || policy === "session" || policy === "persistent" ? policy : "session";
  if (policy !== undefined && policy !== memoryPolicy) {
    errors.push('memory.policy must be "none", "session" or "persistent"');
  }
  const maxEntries = optionalNumber(memoryRaw.maxEntries);
  if (maxEntries !== undefined && (!Number.isInteger(maxEntries) || maxEntries < 0)) {
    errors.push("memory.maxEntries must be a non-negative integer");
  }

  const policiesRaw = isRecord(input.policies) ? input.policies : {};
  const maxTurns = optionalNumber(policiesRaw.maxTurns);
  if (maxTurns !== undefined && maxTurns <= 0) errors.push("policies.maxTurns must be greater than 0");
  const maxCostUsd = optionalNumber(policiesRaw.maxCostUsd);
  if (maxCostUsd !== undefined && maxCostUsd < 0) errors.push("policies.maxCostUsd must not be negative");

  const permissionsRaw = isRecord(input.permissions) ? input.permissions : {};
  const allowTools = uniqueStrings(permissionsRaw.allowTools);
  const denyTools = uniqueStrings(permissionsRaw.denyTools);
  const approvalRequired = permissionsRaw.approvalRequired === true;
  for (const denied of denyTools) {
    if (tools.includes(denied) || allowTools.includes(denied)) {
      warnings.push(`tool "${denied}" is denied but also allowlisted; the deny wins at runtime`);
    }
  }

  const subagents = normalizeSubagents(input.subagents);
  for (const sub of subagents) {
    if (sub.model && !isKnownModel(sub.model, catalog.models)) {
      errors.push(`subagents "${sub.name}" model "${sub.model}" is not a model in the provider catalog`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const manifest: AgentManifest = {
    version: AGENT_MANIFEST_VERSION,
    id,
    name,
    ...(description ? { description } : {}),
    identity: { systemPrompt, ...(tone ? { tone } : {}) },
    models: { preferred, fallbacks },
    tools,
    mcp,
    connectors,
    context,
    memory: { policy: memoryPolicy, ...(maxEntries !== undefined ? { maxEntries } : {}) },
    skills,
    workflows,
    policies: {
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(uniqueStrings(policiesRaw.requireApprovalFor).length > 0
        ? { requireApprovalFor: uniqueStrings(policiesRaw.requireApprovalFor) }
        : {}),
    },
    permissions: { allowTools, denyTools, approvalRequired },
    subagents,
  };
  return { ok: true, manifest, warnings };
}

const SECRET_KEY_RE = /api[_-]?key|token|secret|password|authorization|credential/i;

/**
 * Recursively drop every secret-looking key from a value.
 *
 * Used on export (and import) so a manifest can never carry a credential
 * between environments. The export route additionally re-scans the serialized
 * JSON and fails closed rather than shipping a redacted file.
 */
export function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 20) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => stripSecrets(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) continue;
      const cleaned = stripSecrets(entry, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

/** True when any key in the value looks like a credential (used by the export route). */
export function containsSecretKeys(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (Array.isArray(value)) return value.some((item) => containsSecretKeys(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entry]) => SECRET_KEY_RE.test(key) || containsSecretKeys(entry, depth + 1),
    );
  }
  return false;
}
