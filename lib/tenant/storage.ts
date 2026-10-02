// Per-user storage quota (Jimmy, 20:43 CT): every account gets a hard 0.5 GB on the server, covering everything it
// stores: chats, agent trajectories/step logs, artifacts, screenshots, the browser profile, uploads and workspace
// files. Everything an account stores lives under userHome(user), so usage is "the size of that tree".
//
// - Tracking: a full walk (reconcile) at most every RECONCILE_MS per user, on demand, and every 5 minutes in the
//   background; between walks, writers report what they add via noteWrite() so enforcement is immediate.
// - Enforcement: assertStorage()/storageBlock() refuse new writes and new runs at 100%. Nothing is cut off
//   mid-write: callers check before they start, and the stores write atomically (tmp + rename), so a refused write
//   leaves the previous file intact.
// - Levels: ok < 80% ≤ warn < 95% ≤ critical < 100% ≤ full. The UI shows a meter and warnings from storageReport().
// - The deploy lane backs this with an OS-level cap slightly above the app limit, as a safety net.
//
// Locally (the single "local" user on a laptop) there is no quota unless SWARM_STORAGE_QUOTA_MB is set.

import fs from "node:fs";
import path from "node:path";
import { allUserIds, currentUser, userHome } from "../store";

export const MB = 1024 * 1024;
const RECONCILE_MS = 15_000;
const BACKGROUND_MS = 5 * 60_000;

/** The per-account limit in bytes (Infinity = no limit). */
export function storageLimit(userId = currentUser()): number {
  const env = Number(process.env.SWARM_STORAGE_QUOTA_MB);
  if (Number.isFinite(env) && env > 0) return Math.floor(env * MB);
  return userId === "local" ? Infinity : 512 * MB;
}

export type StorageCategory = "chats" | "trajectories" | "files" | "browser" | "other";
export type StorageLevel = "ok" | "warn" | "critical" | "full";

export interface SessionUsage {
  id: string;
  bytes: number;
}

export interface Usage {
  used: number;
  byCategory: Record<StorageCategory, number>;
  /** Bytes per chat: its session folder plus its uploads and file-edit checkpoints. */
  sessions: Record<string, number>;
  at: number;
}

/** Bytes a file occupies on disk (what an OS quota counts), never less than its length. */
const sizeOf = (st: fs.Stats) => Math.max(st.size, (st.blocks ?? 0) * 512);

function walk(dir: string, visit: (rel: string, bytes: number) => void, rel = "") {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs); // never follow symlinks: a link to another tree is not this user's data
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, visit, r);
    else visit(r, sizeOf(st));
  }
}

const SID = /^[a-f0-9]{16}$/;

/** Which bucket a path (relative to the user's home) belongs to, and which chat it counts against. */
export function classify(rel: string): { cat: StorageCategory; session?: string } {
  const [top, second, third] = rel.split("/");
  if (top === "sessions" && second && SID.test(second)) {
    return { cat: third === "events-archive.jsonl" ? "trajectories" : "chats", session: second };
  }
  if ((top === "uploads" || top === "checkpoints") && second && SID.test(second)) return { cat: "files", session: second };
  if (top === "runtime") return { cat: second === "ledger" ? "trajectories" : "other" };
  if (top === "workspace" || top === "uploads" || top === "downloads" || top === "checkpoints") return { cat: "files" };
  if (top === "browser-profile" || top === "browsers") return { cat: "browser" };
  return { cat: "other" };
}

type Cache = { usage: Usage; pending: number };
const g = globalThis as unknown as { __swarmStorage?: Map<string, Cache>; __swarmStorageTimer?: NodeJS.Timeout };
const cache = (g.__swarmStorage ??= new Map());

/** Walk the user's whole tree now and reset the running total. */
export function reconcile(userId = currentUser()): Usage {
  const usage: Usage = { used: 0, byCategory: { chats: 0, trajectories: 0, files: 0, browser: 0, other: 0 }, sessions: {}, at: Date.now() };
  // The local user's home is SWARM_HOME itself; on a server that would include every account, so skip users/.
  const home = userHome(userId);
  walk(home, (rel, bytes) => {
    if (userId === "local" && rel.startsWith("users/")) return;
    const c = classify(rel);
    usage.used += bytes;
    usage.byCategory[c.cat] += bytes;
    if (c.session) usage.sessions[c.session] = (usage.sessions[c.session] ?? 0) + bytes;
  });
  cache.set(userId, { usage, pending: 0 });
  return usage;
}

/** Current usage: the last walk (re-walked if older than RECONCILE_MS) plus writes reported since. */
export function usage(userId = currentUser(), fresh = false): Usage {
  const c = cache.get(userId);
  if (fresh || !c || Date.now() - c.usage.at > RECONCILE_MS) return reconcile(userId);
  return { ...c.usage, used: c.usage.used + c.pending };
}

/** Report bytes just added (or freed, negative) so enforcement sees them before the next walk. */
export function noteWrite(bytes: number, userId = currentUser()) {
  const c = cache.get(userId);
  if (c && Number.isFinite(bytes)) c.pending = Math.max(-c.usage.used, c.pending + bytes);
}

/** Forget the cached total (after a delete or prune) so the next read walks the tree. */
export function invalidate(userId = currentUser()) {
  cache.delete(userId);
}

export function levelOf(used: number, limit: number): StorageLevel {
  if (!Number.isFinite(limit)) return "ok";
  const pct = used / limit;
  return pct >= 1 ? "full" : pct >= 0.95 ? "critical" : pct >= 0.8 ? "warn" : "ok";
}

export const fmtMB = (n: number) => (n >= 100 * MB ? `${Math.round(n / MB)} MB` : n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export class StorageFullError extends Error {
  readonly status = 507;
  constructor(used: number, limit: number) {
    super(
      `Your storage is full (${fmtMB(used)} of ${fmtMB(limit)}). Nothing new can be saved and no new runs can start until you free space: delete old chats in Settings → Storage, or turn on auto-prune there.`,
    );
    this.name = "StorageFullError";
  }
}

/**
 * Why a write of `extra` bytes (or a new run, extra = 0) must be refused right now, or null if it may go ahead.
 * `grace` lets an already-running agent finish saving its current step (a fraction of the limit) instead of
 * losing it; new writes and new runs get no grace.
 */
export function storageBlock(extra = 0, opts: { grace?: number } = {}, userId = currentUser()): StorageFullError | null {
  const limit = storageLimit(userId);
  if (!Number.isFinite(limit)) return null;
  const used = usage(userId).used;
  const allowed = limit * (1 + Math.max(0, opts.grace ?? 0));
  return used + Math.max(0, extra) > allowed || (extra === 0 && used >= allowed) ? new StorageFullError(used, limit) : null;
}

/** Throw StorageFullError if a write of `extra` bytes (or a new run) is over the limit. */
export function assertStorage(extra = 0, opts: { grace?: number } = {}, userId = currentUser()) {
  const e = storageBlock(extra, opts, userId);
  if (e) throw e;
}

/** A JSON 507 response for a refused request (routes return this instead of doing the work). */
export function storageFullResponse(e: StorageFullError) {
  return Response.json({ error: e.message, storage: "full" }, { status: 507 });
}

// ---- background reconcile + auto-prune hook ----

type Hook = (userId: string, u: Usage) => void | Promise<void>;
const hooks: Hook[] = [];
/** Run after every background reconcile (lib/tenant/prune.ts registers auto-prune here). */
export function onReconcile(h: Hook) {
  hooks.push(h);
}

export function startStorageReconciler() {
  if (g.__swarmStorageTimer || process.env.SWARM_MODE !== "server") return;
  g.__swarmStorageTimer = setInterval(() => void reconcileAll(), BACKGROUND_MS);
  g.__swarmStorageTimer.unref?.();
}

export async function reconcileAll() {
  for (const uid of allUserIds()) {
    try {
      const u = reconcile(uid);
      for (const h of hooks) await h(uid, u);
    } catch {}
  }
}
