import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentEvent, LearnedLimits, Msg, ProviderConfig, SessionMeta } from "./types";

// ---- Tenancy ----
// Every piece of user data lives under the current user's home. Locally that is ROOT itself (one user, "local",
// the original layout). On a server (SWARM_MODE=server) each account gets ROOT/users/<id>, and the current user
// comes from an AsyncLocalStorage context: route handlers enter it via lib/auth `scoped()`, agent runs via
// runAs(). With no context on a server, currentUser() throws rather than fall back to shared storage.

export const ROOT = process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents");
fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });

const tg = globalThis as unknown as { __swarmTenant?: AsyncLocalStorage<string> };
const tenant = (tg.__swarmTenant ??= new AsyncLocalStorage<string>());

export class NoUserContextError extends Error {
  constructor() {
    super("No signed-in user for this operation (server mode requires a tenant context).");
  }
}

/** Run fn (and everything it awaits or schedules) as this user. */
export const runAs = <T>(userId: string, fn: () => T): T => tenant.run(userId, fn);

export function currentUser(): string {
  const u = tenant.getStore();
  if (u) return u;
  if (process.env.SWARM_MODE === "server") throw new NoUserContextError();
  return "local";
}

const ensure = (d: string) => (fs.mkdirSync(d, { recursive: true, mode: 0o700 }), d);

/** The data directory of a user (default: the current one). */
export function userHome(userId = currentUser()): string {
  if (userId === "local") return ROOT;
  if (!/^[a-f0-9]{16}$/.test(userId)) throw new Error("bad user id");
  return ensure(path.join(ROOT, "users", userId));
}

/** Every user with data on this server (boot-time work such as resuming runs iterates these). */
export function allUserIds(): string[] {
  if (process.env.SWARM_MODE !== "server") return ["local"];
  try {
    return fs.readdirSync(path.join(ROOT, "users")).filter((d) => /^[a-f0-9]{16}$/.test(d));
  } catch {
    return [];
  }
}

export const sessionsDir = () => ensure(path.join(userHome(), "sessions"));
export const uploadsDir = () => ensure(path.join(userHome(), "uploads"));
export const browserProfile = () => path.join(userHome(), "browser-profile");
export const mcpConfig = () => path.join(userHome(), "mcp.json");
const settingsFile = () => path.join(userHome(), "settings.json");
const limitsFile = () => path.join(userHome(), "limits.json");

/** @deprecated Server-global, not per user. Use userHome(). Kept only until every module has migrated. */
export const HOME = ROOT;
/** @deprecated Use uploadsDir(). */
export const UPLOADS_DIR = path.join(ROOT, "uploads");
/** @deprecated Use browserProfile(). */
export const BROWSER_PROFILE = path.join(ROOT, "browser-profile");
/** @deprecated Use mcpConfig(). */
export const MCP_CONFIG = path.join(ROOT, "mcp.json");

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
  return readJson<{ providers: ProviderConfig[] }>(settingsFile(), { providers: [] }).providers;
}

export function saveProviders(providers: ProviderConfig[]) {
  // Preserve sibling settings fields (e.g. search) that live in the same file.
  const cur = readJson<Record<string, unknown>>(settingsFile(), {});
  writeJson(settingsFile(), { ...cur, providers });
}

// ---- Web search (optional API key; lane B may surface this in Settings UI) ----

export interface SearchConfig {
  provider: "tavily";
  apiKey: string;
}

export function getSearchConfig(): SearchConfig | null {
  const s = readJson<{ search?: SearchConfig }>(settingsFile(), {});
  if (s.search?.apiKey) return s.search;
  const env = process.env.TAVILY_API_KEY || process.env.SEARCH_API_KEY;
  if (env) return { provider: "tavily", apiKey: env };
  return null;
}

export function saveSearchConfig(search: SearchConfig | null) {
  const cur = readJson<Record<string, unknown>>(settingsFile(), {});
  if (search) cur.search = search;
  else delete cur.search;
  writeJson(settingsFile(), cur);
}

// ---- Learned rate limits (persist across restarts) ----

export function getLimits(): Record<string, LearnedLimits> {
  return readJson(limitsFile(), {});
}

export function saveLimits(limits: Record<string, LearnedLimits>) {
  writeJson(limitsFile(), limits);
}

// ---- Sessions ----

const sdir = (id: string) => {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("bad session id");
  return path.join(sessionsDir(), id);
};

export function createSession(): SessionMeta {
  const meta: SessionMeta = { id: newId(), title: "New task", createdAt: Date.now(), updatedAt: Date.now(), cwd: os.homedir() };
  fs.mkdirSync(sdir(meta.id), { recursive: true });
  saveMeta(meta);
  return meta;
}

export function listSessions(): SessionMeta[] {
  return fs
    .readdirSync(sessionsDir())
    .map((id) => readJson<SessionMeta | null>(path.join(sessionsDir(), id, "meta.json"), null))
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
  fs.rmSync(path.join(uploadsDir(), id), { recursive: true, force: true });
  // File-edit snapshots (lib/tools/files.ts) live outside the session dir; remove them too (best-effort).
  try {
    fs.rmSync(path.join(userHome(), "checkpoints", id), { recursive: true, force: true });
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

/**
 * Archived events [before - limit, before), oldest first. Indexes count from the start of the session; `total` is
 * the archived count. The file is read backwards in chunks, so recent pages cost O(page) however big the archive.
 */
export function loadArchivedEvents(id: string, before: number, limit: number, total: number): AgentEvent[] {
  let fd: number;
  try {
    fd = fs.openSync(archiveFile(id), "r");
  } catch {
    return [];
  }
  try {
    const end = Math.min(before, total);
    const start = Math.max(0, end - limit);
    const skip = total - end; // lines after the page, counted from the end of the file
    const want = end - start;
    const out: string[] = [];
    let pos = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let seen = 0;
    const CHUNK = 1 << 20;
    while (pos > 0 && out.length < want) {
      const n = Math.min(CHUNK, pos);
      pos -= n;
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, pos);
      carry = Buffer.concat([buf, carry]);
      let nl = carry.lastIndexOf(10, carry.length - 2);
      // Peel complete lines off the end; the remainder before the first newline waits for the next chunk.
      while (nl >= 0 && out.length < want) {
        const line = carry.subarray(nl + 1).toString("utf8").trim();
        carry = carry.subarray(0, nl + 1);
        if (line && seen++ >= skip) out.push(line);
        nl = carry.lastIndexOf(10, carry.length - 2);
      }
    }
    if (pos === 0 && out.length < want) {
      const line = carry.toString("utf8").trim();
      if (line && seen++ >= skip) out.push(line);
    }
    return out.reverse().map((l) => JSON.parse(l) as AgentEvent);
  } finally {
    fs.closeSync(fd);
  }
}

export function sessionDir(id: string) {
  return sdir(id);
}
