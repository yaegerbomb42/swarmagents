import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseYaml } from './yaml-parser.js';
import type { McpServerBinding, RoleDefinition, RolePermissions } from './types.js';
import type { RoleRegistry } from './registry.js';

export interface LoadResult {
  roles: RoleDefinition[];
  errors: string[];
}

function parseMcpServers(raw: unknown): readonly McpServerBinding[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: McpServerBinding[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ name: item, load: 'lazy' });
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      if (typeof rec.name === 'string' && rec.name.trim()) {
        out.push({ name: rec.name, load: rec.load === 'eager' ? 'eager' : 'lazy' });
      }
    }
  }
  return out;
}

function parseModelConfig(raw: unknown): RoleDefinition['modelConfig'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  const num = (k: string): number | undefined =>
    typeof m[k] === 'number' && Number.isFinite(m[k]) ? (m[k] as number) : undefined;
  const str = (k: string): string | undefined => (typeof m[k] === 'string' ? m[k] : undefined);
  const cfg: Partial<import('./types.js').ModelConfig> = {};
  const provider = str('provider');
  const modelId = str('modelId');
  const temperature = num('temperature');
  const maxContextTokens = num('maxContextTokens');
  const maxTokens = num('maxTokens');
  const maxTurns = num('maxTurns');
  const turnTimeoutMs = num('turnTimeoutMs');
  const deadlineMs = num('deadlineMs');
  if (provider !== undefined) cfg.provider = provider;
  if (modelId !== undefined) cfg.modelId = modelId;
  if (temperature !== undefined) cfg.temperature = temperature;
  if (maxContextTokens !== undefined) cfg.maxContextTokens = maxContextTokens;
  if (maxTokens !== undefined) cfg.maxTokens = maxTokens;
  if (maxTurns !== undefined) cfg.maxTurns = Math.floor(maxTurns);
  if (turnTimeoutMs !== undefined) cfg.turnTimeoutMs = Math.floor(turnTimeoutMs);
  if (deadlineMs !== undefined) cfg.deadlineMs = Math.floor(deadlineMs);
  return Object.keys(cfg).length ? cfg : undefined;
}

function parsePermissions(raw: unknown): RoleDefinition['permissions'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  // Accept the brief's names, plus a few obvious aliases.
  const bool = (...keys: string[]): boolean | undefined => {
    for (const k of keys) {
      if (typeof p[k] === 'boolean') return p[k] as boolean;
    }
    return undefined;
  };
  const permissions: Partial<RolePermissions> = {};
  const readOnly = bool('readOnly');
  const networkAllowed = bool('networkAllowed', 'external');
  const commandExecutionAllowed = bool('commandExecutionAllowed', 'execute');
  if (readOnly !== undefined) permissions.readOnly = readOnly;
  if (networkAllowed !== undefined) permissions.networkAllowed = networkAllowed;
  if (commandExecutionAllowed !== undefined) {
    permissions.commandExecutionAllowed = commandExecutionAllowed;
  }
  return Object.keys(permissions).length ? permissions : undefined;
}

/**
 * Convert a plain object (from JSON or YAML) into a RoleDefinition,
 * stripping unknown keys.
 */
function normalizeRole(obj: unknown, sourcePath: string): { role?: RoleDefinition; errors: string[] } {
  const errors: string[] = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(`Non-object entry in ${sourcePath}`);
    return { errors };
  }

  const raw = obj as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) {
    errors.push(`Missing id in entry from ${sourcePath}`);
    return { errors };
  }

  const name = typeof raw.name === 'string' ? raw.name : id;
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools.filter((t): t is string => typeof t === 'string')
    : undefined;
  const mcpServers = parseMcpServers(raw.mcpServers);
  const systemPrompt = typeof raw.systemPrompt === 'string' ? raw.systemPrompt : undefined;
  const extendsVal = typeof raw.extends === 'string' ? raw.extends : undefined;
  const maxTurns = typeof raw.maxTurns === 'number' ? Math.floor(raw.maxTurns) : undefined;
  const maxDeadlineMs = typeof raw.maxDeadlineMs === 'number' ? Math.floor(raw.maxDeadlineMs) : undefined;
  const modelConfig = parseModelConfig(raw.modelConfig);
  const permissions = parsePermissions(raw.permissions);

  const role: RoleDefinition = {
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(modelConfig !== undefined ? { modelConfig } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxDeadlineMs !== undefined ? { maxDeadlineMs } : {}),
    ...(extendsVal !== undefined ? { extends: extendsVal } : {}),
  };
  return { role, errors };
}

function isArrayOfObjects(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
}

function entriesFromParsed(parsed: unknown): { entries?: Record<string, unknown>[]; error?: string } {
  if (isArrayOfObjects(parsed)) return { entries: parsed };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    if (isArrayOfObjects(rec.roles)) return { entries: rec.roles };
    return { entries: [rec] };
  }
  return { error: 'document did not parse to an object, array, or { roles: [...] }' };
}

function loadEntries(parsed: unknown, source: string): LoadResult {
  const coerced = entriesFromParsed(parsed);
  if (!coerced.entries) return { roles: [], errors: [coerced.error ?? `Invalid ${source}`] };
  const roles: RoleDefinition[] = [];
  const errors: string[] = [];
  for (const entry of coerced.entries) {
    const res = normalizeRole(entry, source);
    if (res.role) roles.push(res.role);
    errors.push(...res.errors);
  }
  return { roles, errors };
}

/** Load role definitions from a YAML string. */
export function loadRolesFromYaml(text: string): LoadResult {
  const parsed = parseYaml(text);
  return loadEntries(parsed, '<yaml>');
}

/** Load role definitions from a JSON string. */
export function loadRolesFromJson(text: string): LoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { roles: [], errors: ['Invalid JSON'] };
  }
  return loadEntries(parsed, '<json>');
}

const DEFAULT_ROLE_FILES = [
  'roles.yaml',
  'roles.yml',
  '.roles.yaml',
  '.roles.yml',
  '.roles.json',
] as const;

/**
 * Load role files from a project root. Prefers `roles.yaml` / `roles.yml`,
 * then `.roles.yaml` / `.roles.yml`, then `.roles.json`. The first file that
 * exists is used. An explicit path may be passed as the second argument.
 */
export async function loadRoleFiles(projectRoot: string, explicitPath?: string): Promise<LoadResult> {
  const candidates = explicitPath
    ? [isAbsolute(explicitPath) ? explicitPath : join(projectRoot, explicitPath)]
    : DEFAULT_ROLE_FILES.map((name) => join(projectRoot, name));

  const errors: string[] = [];
  for (const p of candidates) {
    try {
      await access(p);
      const text = await readFile(p, 'utf8');
      if (p.endsWith('.json')) {
        const r = loadRolesFromJson(text);
        return { roles: r.roles, errors: [...errors, ...r.errors] };
      }
      const r = loadRolesFromYaml(text);
      return { roles: r.roles, errors: [...errors, ...r.errors] };
    } catch (e: unknown) {
      const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code: string }).code : undefined;
      if (code === 'ENOENT') continue;
      if (e instanceof Error) errors.push(`${p}: ${e.message}`);
      else errors.push(`${p}: unknown error`);
    }
  }
  return { roles: [], errors };
}

/** Discover and register custom roles into a registry. Returns load errors (if any). */
export async function registerCustomRoles(
  registry: RoleRegistry,
  projectRoot: string,
  explicitPath?: string,
): Promise<string[]> {
  const { roles, errors } = await loadRoleFiles(projectRoot, explicitPath);
  registry.registerMany(roles);
  return errors;
}
