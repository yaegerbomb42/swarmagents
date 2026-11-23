/**
 * Per-account agent storage (Agent Studio, phase 2).
 *
 * Layout: `<data dir>/agents/<hash(userId)>/<id>.json` (dir 0700, file 0600)
 * plus `<id>.history.json` holding the previous versions of that agent. Every
 * write is atomic (temp + fsync + rename) so a crash never leaves a half-written
 * manifest, and every save validates first — an invalid manifest is never
 * persisted, not even as history.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../atomic-write";
import { resolveDataDir, userDirName } from "../providers/store";
import { buildAgentCatalog } from "./catalog";
import {
  containsSecretKeys,
  stripSecrets,
  validateManifest,
  type AgentCatalog,
  type AgentManifest,
} from "./manifest";

export const AGENT_HISTORY_LIMIT = 20;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

let DATA_DIR_OVERRIDE: string | undefined;

/** Point agent storage at a fixed directory (tests). `undefined` restores default. */
export function configureAgentsDir(dir: string | undefined): void {
  DATA_DIR_OVERRIDE = dir || undefined;
}

export function agentsRoot(): string {
  return DATA_DIR_OVERRIDE ?? resolveDataDir();
}

export function userAgentsDir(userId: string): string {
  const dir = path.join(agentsRoot(), "agents", userDirName(userId));
  return dir;
}

function agentFile(userId: string, id: string): string {
  if (!AGENT_ID_RE.test(id)) throw new Error("invalid agent id");
  return path.join(userAgentsDir(userId), `${id}.json`);
}

function historyFile(userId: string, id: string): string {
  return path.join(userAgentsDir(userId), `${id}.history.json`);
}

export interface AgentHistoryEntry {
  savedAt: number;
  manifest: AgentManifest;
}

export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  version: number;
  updatedAt: number;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: the directory may be on a filesystem without modes.
  }
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

export function getAgent(userId: string, id: string): AgentManifest | null {
  let file: string;
  try {
    file = agentFile(userId, id);
  } catch {
    return null;
  }
  const raw = readJsonFile(file);
  if (!raw) return null;
  // Validated on write; re-read without the catalog check so an agent whose
  // skill was later removed from the library is still readable and editable.
  const validated = validateManifest(raw, catalogFor(userId), { requireCatalogIds: false });
  return validated.ok ? validated.manifest : null;
}

export function listAgents(userId: string): AgentSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(userAgentsDir(userId));
  } catch {
    return [];
  }
  const out: AgentSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".history.json")) continue;
    const id = name.slice(0, -".json".length);
    const file = path.join(userAgentsDir(userId), name);
    const raw = readJsonFile(file) as { id?: unknown; name?: unknown; description?: unknown; version?: unknown } | undefined;
    if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") continue;
    let updatedAt = 0;
    try {
      updatedAt = Math.floor(fs.statSync(file).mtimeMs);
    } catch {
      // keep 0
    }
    out.push({
      id,
      name: raw.name,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      version: typeof raw.version === "number" ? raw.version : 1,
      updatedAt,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The account's catalog: their installed library skills/MCP servers plus the
 * provider models and shipped connectors. A caller may pass its own catalog
 * (tests do) to keep the check deterministic.
 */
function catalogFor(userId: string): AgentCatalog {
  return buildAgentCatalog(userId);
}


function readHistory(userId: string, id: string): AgentHistoryEntry[] {
  const raw = readJsonFile(historyFile(userId, id));
  if (!Array.isArray(raw)) return [];
  const out: AgentHistoryEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { savedAt?: unknown; manifest?: unknown };
    if (typeof record.savedAt !== "number" || !record.manifest) continue;
    out.push({ savedAt: record.savedAt, manifest: record.manifest as AgentManifest });
  }
  return out;
}

function writeHistory(userId: string, id: string, entries: AgentHistoryEntry[]): void {
  const trimmed = entries.slice(-AGENT_HISTORY_LIMIT);
  atomicWriteFile(historyFile(userId, id), JSON.stringify(trimmed, null, 2), { mode: 0o600 });
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  async acquire<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const globals = globalThis as typeof globalThis & { __swarmAgentWriteLocks?: Map<string, AsyncLock> };
const agentLocks = (globals.__swarmAgentWriteLocks ??= new Map<string, AsyncLock>());

function getLock(userId: string, id: string): AsyncLock {
  const key = `${userId}:${id}`;
  let lock = agentLocks.get(key);
  if (!lock) {
    lock = new AsyncLock();
    agentLocks.set(key, lock);
  }
  return lock;
}

/**
 * Execute a mutation on a specific agent under an in-process per-agent lock.
 */
export function withAgentLock<T>(userId: string, id: string, fn: () => T | Promise<T>): Promise<T> {
  const canonicalId = id.trim();
  return getLock(userId, canonicalId).acquire(fn);
}

export type SaveAgentResult =
  | { ok: true; manifest: AgentManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/**
 * Create a new agent atomically: checks whether the agent already exists inside
 * the lock and rejects with conflict: true if so, eliminating check-then-act races.
 */
export async function createAgentAtomic(
  userId: string,
  input: unknown,
  catalog: AgentCatalog = catalogFor(userId),
): Promise<
  | { ok: true; manifest: AgentManifest; warnings: string[] }
  | { ok: false; conflict: true; id: string }
  | { ok: false; conflict?: false; errors: string[]; warnings: string[] }
> {
  const rawId =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).id
      : undefined;
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!id) {
    const validated = validateManifest(input, catalog);
    if (!validated.ok) return { ok: false, errors: validated.errors, warnings: validated.warnings };
    return saveAgent(userId, input, catalog);
  }

  return withAgentLock(userId, id, () => {
    if (getAgent(userId, id)) {
      return { ok: false, conflict: true, id };
    }
    return saveAgent(userId, input, catalog);
  });
}

/**
 * Update an existing agent atomically: verifies existence inside the lock
 * before replacing, eliminating check-then-act races.
 */
export async function updateAgentAtomic(
  userId: string,
  id: string,
  input: unknown,
  catalog: AgentCatalog = catalogFor(userId),
): Promise<
  | { ok: true; manifest: AgentManifest; warnings: string[] }
  | { ok: false; notFound: true }
  | { ok: false; errors: string[]; warnings: string[] }
> {
  const canonicalId = id.trim();
  return withAgentLock(userId, canonicalId, () => {
    if (!getAgent(userId, canonicalId)) {
      return { ok: false, notFound: true };
    }
    return saveAgent(userId, input, catalog);
  });
}

/**
 * Validate, then write. The previous version (when there is one) moves into
 * the history file, capped at AGENT_HISTORY_LIMIT entries.
 */
export function saveAgent(
  userId: string,
  input: unknown,
  catalog: AgentCatalog = catalogFor(userId),
): SaveAgentResult {
  const validated = validateManifest(input, catalog);
  if (!validated.ok) return { ok: false, errors: validated.errors, warnings: validated.warnings };

  const manifest = validated.manifest;
  const previous = getAgent(userId, manifest.id);
  ensureDir(userAgentsDir(userId));

  if (previous) {
    const history = readHistory(userId, manifest.id);
    history.push({ savedAt: Date.now(), manifest: previous });
    writeHistory(userId, manifest.id, history);
  }
  atomicWriteFile(agentFile(userId, manifest.id), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { ok: true, manifest, warnings: validated.warnings };
}

export function deleteAgent(userId: string, id: string): boolean {
  let file: string;
  let hist: string;
  try {
    file = agentFile(userId, id);
    hist = historyFile(userId, id);
  } catch {
    return false;
  }
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  fs.rmSync(hist, { force: true });
  return true;
}

/** Previous versions, newest first. */
export function getAgentHistory(userId: string, id: string): AgentHistoryEntry[] {
  return readHistory(userId, id).slice().reverse();
}

/**
 * Restore a prior version as current. `versionIndex` is the index into
 * getAgentHistory() (0 = most recent previous version). The current manifest
 * is pushed into history first, so a restore is itself reversible.
 */
export function restoreAgentVersion(
  userId: string,
  id: string,
  versionIndex: number,
  catalog: AgentCatalog = catalogFor(userId),
): { ok: true; manifest: AgentManifest } | { ok: false; error: string } {
  const history = getAgentHistory(userId, id);
  const entry = history[versionIndex];
  if (!entry) return { ok: false, error: "version not found" };
  const result = saveAgent(userId, entry.manifest, catalog);
  return result.ok ? { ok: true, manifest: result.manifest } : { ok: false, error: result.errors.join("; ") };
}

function uniqueId(userId: string, base: string): string {
  const exists = (id: string) => fs.existsSync(agentFile(userId, id));
  if (!exists(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 64);
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 64);
}

export function cloneAgent(
  userId: string,
  id: string,
  newId?: string,
  catalog: AgentCatalog = catalogFor(userId),
): { ok: true; manifest: AgentManifest } | { ok: false; error: string } {
  const source = getAgent(userId, id);
  if (!source) return { ok: false, error: "agent not found" };
  const requested = newId && AGENT_ID_RE.test(newId) ? newId : undefined;
  const targetId = requested ? uniqueId(userId, requested) : uniqueId(userId, `${id}-copy`.slice(0, 64));
  const copy: AgentManifest = {
    ...JSON.parse(JSON.stringify(source)),
    id: targetId,
    name: `${source.name} (copy)`.slice(0, 100),
  };
  const saved = saveAgent(userId, copy, catalog);
  return saved.ok ? { ok: true, manifest: saved.manifest } : { ok: false, error: saved.errors.join("; ") };
}

/**
 * Validate an untrusted package/bare manifest and store it.
 *
 * Unknown skills and workflows are dropped and reported as warnings (the
 * skill simply does not exist in the destination account), while everything
 * else must validate. Secrets are stripped before validation.
 */
export function importAgent(
  userId: string,
  json: unknown,
  catalog: AgentCatalog = catalogFor(userId),
): { ok: true; manifest: AgentManifest; warnings: string[] } | { ok: false; errors: string[] } {
  const stripped = stripSecrets(json) as Record<string, unknown> | undefined;
  if (!stripped || typeof stripped !== "object") return { ok: false, errors: ["package is not a JSON object"] };

  // A package wrapper carries the manifest under `agent`.
  const candidate =
    "agent" in stripped && stripped.agent && typeof stripped.agent === "object"
      ? (stripped.agent as Record<string, unknown>)
      : stripped;

  const warnings: string[] = [];
  const first = validateManifest(candidate, catalog);
  if (!first.ok) {
    const onlyMissingIds = first.errors.every((e) => /^skill ".+" does not exist|^workflow ".+" does not exist/.test(e));
    if (!onlyMissingIds) return { ok: false, errors: first.errors };
  }

  const skills = Array.isArray(candidate.skills) ? candidate.skills.filter((s): s is string => typeof s === "string") : [];
  const workflows = Array.isArray(candidate.workflows)
    ? candidate.workflows.filter((s): s is string => typeof s === "string")
    : [];
  const keptSkills = skills.filter((skill) => {
    if (catalog.skills.has(skill)) return true;
    warnings.push(`skill "${skill}" does not exist in this account and was skipped`);
    return false;
  });
  const keptWorkflows = workflows.filter((workflow) => {
    if (catalog.workflows.has(workflow)) return true;
    warnings.push(`workflow "${workflow}" does not exist in this account and was skipped`);
    return false;
  });

  const requestedId = typeof candidate.id === "string" && AGENT_ID_RE.test(candidate.id) ? candidate.id : "imported-agent";
  const next: Record<string, unknown> = {
    ...candidate,
    id: uniqueId(userId, requestedId),
    skills: keptSkills,
    workflows: keptWorkflows,
    version: 1,
  };

  const saved = saveAgent(userId, next, catalog);
  if (!saved.ok) return { ok: false, errors: saved.errors };
  return { ok: true, manifest: saved.manifest, warnings: [...warnings, ...saved.warnings] };
}

export interface AgentExportPackage {
  format: "swarm-agent";
  formatVersion: 1;
  exportedAt: string;
  agent: Record<string, unknown>;
}

/**
 * The portable package: configuration and instructions only. No secrets, no
 * environment bindings, no execution state, no private memory.
 */
export function exportAgent(userId: string, id: string): AgentExportPackage | null {
  const manifest = getAgent(userId, id);
  if (!manifest) return null;
  const agent = stripSecrets(manifest) as Record<string, unknown>;
  return {
    format: "swarm-agent",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    agent,
  };
}

/** Guard for the export route: refuse to ship a package that still looks secret. */
export function exportContainsSecrets(pkg: AgentExportPackage): boolean {
  return containsSecretKeys(pkg);
}
