import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { AgentEvent, LearnedLimits, Msg, ProviderConfig, SessionMeta } from "./types";

export const HOME = process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents");
export const SESSIONS_DIR = path.join(HOME, "sessions");
export const UPLOADS_DIR = path.join(HOME, "uploads");
export const BROWSER_PROFILE = path.join(HOME, "browser-profile");
export const MCP_CONFIG = path.join(HOME, "mcp.json");
const SETTINGS = path.join(HOME, "settings.json");
const LIMITS = path.join(HOME, "limits.json");

for (const d of [HOME, SESSIONS_DIR, UPLOADS_DIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

export const newId = () => crypto.randomBytes(8).toString("hex");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
}

// ---- Providers ----

export function getProviders(): ProviderConfig[] {
  return readJson<{ providers: ProviderConfig[] }>(SETTINGS, { providers: [] }).providers;
}

export function saveProviders(providers: ProviderConfig[]) {
  // Preserve sibling settings fields (e.g. search) that live in the same file.
  const cur = readJson<Record<string, unknown>>(SETTINGS, {});
  writeJson(SETTINGS, { ...cur, providers });
}

// ---- Web search (optional API key; lane B may surface this in Settings UI) ----

export interface SearchConfig {
  provider: "tavily";
  apiKey: string;
}

export function getSearchConfig(): SearchConfig | null {
  const s = readJson<{ search?: SearchConfig }>(SETTINGS, {});
  if (s.search?.apiKey) return s.search;
  const env = process.env.TAVILY_API_KEY || process.env.SEARCH_API_KEY;
  if (env) return { provider: "tavily", apiKey: env };
  return null;
}

export function saveSearchConfig(search: SearchConfig | null) {
  const cur = readJson<Record<string, unknown>>(SETTINGS, {});
  if (search) cur.search = search;
  else delete cur.search;
  writeJson(SETTINGS, cur);
}

// ---- Learned rate limits (persist across restarts) ----

export function getLimits(): Record<string, LearnedLimits> {
  return readJson(LIMITS, {});
}

export function saveLimits(limits: Record<string, LearnedLimits>) {
  writeJson(LIMITS, limits);
}

// ---- Sessions ----

const sdir = (id: string) => {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("bad session id");
  return path.join(SESSIONS_DIR, id);
};

export function createSession(): SessionMeta {
  const meta: SessionMeta = { id: newId(), title: "New task", createdAt: Date.now(), updatedAt: Date.now(), cwd: os.homedir() };
  fs.mkdirSync(sdir(meta.id), { recursive: true });
  saveMeta(meta);
  return meta;
}

export function listSessions(): SessionMeta[] {
  return fs
    .readdirSync(SESSIONS_DIR)
    .map((id) => readJson<SessionMeta | null>(path.join(SESSIONS_DIR, id, "meta.json"), null))
    .filter((m): m is SessionMeta => !!m)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMeta(id: string): SessionMeta | null {
  return readJson<SessionMeta | null>(path.join(sdir(id), "meta.json"), null);
}

export function saveMeta(meta: SessionMeta) {
  writeJson(path.join(sdir(meta.id), "meta.json"), meta);
}

export function deleteSession(id: string) {
  fs.rmSync(sdir(id), { recursive: true, force: true });
  fs.rmSync(path.join(UPLOADS_DIR, id), { recursive: true, force: true });
  // File-edit snapshots (lib/tools/files.ts) live outside the session dir; remove them too (best-effort).
  try {
    fs.rmSync(path.join(HOME, "checkpoints", id), { recursive: true, force: true });
  } catch {}
}

export function loadHistory(id: string): Msg[] {
  return readJson(path.join(sdir(id), "history.json"), []);
}

export function saveHistory(id: string, history: Msg[]) {
  writeJson(path.join(sdir(id), "history.json"), history);
}

export function loadEvents(id: string): AgentEvent[] {
  return readJson(path.join(sdir(id), "events.json"), []);
}

export function saveEvents(id: string, events: AgentEvent[]) {
  writeJson(path.join(sdir(id), "events.json"), events);
}

// Long runs produce unbounded events. The oldest settled ones move to an append-only JSONL archive that is
// written once and never rewritten, so saves and the live snapshot stay small however long a task runs.
const archiveFile = (id: string) => path.join(sdir(id), "events-archive.jsonl");

export function archiveEvents(id: string, events: AgentEvent[]) {
  fs.appendFileSync(archiveFile(id), events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
}

/** Archived events [before - limit, before), oldest first. Indexes count from the start of the session. */
export function loadArchivedEvents(id: string, before: number, limit: number): AgentEvent[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(archiveFile(id), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const end = Math.min(before, lines.length);
  return lines.slice(Math.max(0, end - limit), end).map((l) => JSON.parse(l) as AgentEvent);
}

export function sessionDir(id: string) {
  return sdir(id);
}
