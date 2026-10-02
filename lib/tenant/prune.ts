// Storage settings, clean-up and auto-prune for the per-user quota (lib/tenant/storage.ts).
//
// Auto-prune (a per-user toggle, off by default) runs when an account passes PRUNE_AT of its limit and frees space
// down to PRUNE_TO, cheapest loss first:
//   1. screenshots inside old chats (the images are dropped, the text of every step stays),
//   2. trajectory detail: old archived steps and finished tasks' step logs are compacted (long outputs cut),
//   3. whole chats, oldest last-used first.
// It never touches a pinned chat, a chat whose agent is running or that a live task drives, or anything outside
// the user's own home. Every action is logged with what it freed, and the Settings → Storage panel shows the log.
// All rewrites are atomic (tmp + rename), so an interrupted prune leaves the old file, never a half-written one.

import fs from "node:fs";
import path from "node:path";
import { deleteSession, getMeta, listSessions, runAs, sessionDir, userHome } from "../store";
import type { SessionMeta } from "../types";
import { dropSession } from "../agent";
import { getAgentAdapter } from "../runtime/resume";
import { fmtMB, invalidate, onReconcile, reconcile, startStorageReconciler, storageLimit, usage, type Usage } from "./storage";

export const PRUNE_AT = 0.9;
export const PRUNE_TO = 0.75;
const LOG_MAX = 200;

export interface StorageSettings {
  autoPrune: boolean;
  pinned: string[];
}

export interface PruneEntry {
  at: number;
  kind: "screenshots" | "trajectory" | "chat" | "clear-old" | "delete";
  sessionId?: string;
  title?: string;
  freed: number;
  auto: boolean;
}

const settingsFile = () => path.join(userHome(), "storage.json");
const logFile = () => path.join(userHome(), "storage-log.json");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${Date.now()}.prune.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function getStorageSettings(): StorageSettings {
  const s = readJson<Partial<StorageSettings>>(settingsFile(), {});
  return { autoPrune: s.autoPrune === true, pinned: Array.isArray(s.pinned) ? s.pinned.filter((x) => typeof x === "string" && /^[a-f0-9]{16}$/.test(x)) : [] };
}

export function saveStorageSettings(patch: Partial<StorageSettings>): StorageSettings {
  const next = { ...getStorageSettings(), ...patch };
  writeAtomic(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

export function pruneLog(): PruneEntry[] {
  const l = readJson<PruneEntry[]>(logFile(), []);
  return Array.isArray(l) ? l : [];
}

function log(entries: PruneEntry[]) {
  if (!entries.length) return;
  writeAtomic(logFile(), JSON.stringify([...entries, ...pruneLog()].slice(0, LOG_MAX), null, 2));
}

const fileSize = (f: string) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
};

/** Is this chat in use right now: its agent running, a resume pending, or a live task driving it? */
export function chatBusy(m: SessionMeta): boolean {
  if (m.active || m.pendingInput?.length) return true;
  if (getAgentAdapter()?.isRunning(m.id)) return true;
  // Tasks live in the user's runtime store; any task that can still run keeps its chat.
  const tasks = readJson<{ sessionId: string; status: string }[]>(path.join(userHome(), "runtime", "tasks.json"), []);
  return Array.isArray(tasks) && tasks.some((t) => t.sessionId === m.id && ["queued", "running", "waiting", "blocked"].includes(t.status));
}

/** Chats that may be pruned, least recently used first. */
function candidates(): SessionMeta[] {
  const pinned = new Set(getStorageSettings().pinned);
  return listSessions()
    .filter((m) => !pinned.has(m.id) && !chatBusy(m))
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

type Json = Record<string, unknown>;

/** Drop images from a list of events or history messages. Returns how many were removed. */
function stripImages(items: Json[]): number {
  let n = 0;
  for (const it of items) {
    if (Array.isArray(it.images) && it.images.length) {
      n += it.images.length;
      delete it.images;
      it.imagesPruned = true;
    }
    if (Array.isArray(it.blocks)) n += stripImages(it.blocks as Json[]);
  }
  return n;
}

const CUT = 400;
function compactEvent(e: Json): Json {
  const out: Json = { ...e };
  delete out.images;
  for (const k of ["output", "text", "thinking", "input", "content"]) {
    const v = out[k];
    if (typeof v === "string" && v.length > CUT) out[k] = `${v.slice(0, CUT)}\n…[compacted by storage auto-prune]`;
  }
  return out;
}

function rewriteJson(file: string, fn: (data: Json[]) => boolean): number {
  const before = fileSize(file);
  if (!before) return 0;
  const data = readJson<Json[] | null>(file, null);
  if (!Array.isArray(data) || !fn(data)) return 0;
  writeAtomic(file, JSON.stringify(data, null, 2));
  return Math.max(0, before - fileSize(file));
}

function pruneScreenshots(m: SessionMeta): number {
  dropSession(m.id); // the cached copy would write the images back on its next save
  const dir = sessionDir(m.id);
  return rewriteJson(path.join(dir, "events.json"), (d) => stripImages(d) > 0) + rewriteJson(path.join(dir, "history.json"), (d) => stripImages(d) > 0);
}

function pruneTrajectory(m: SessionMeta): number {
  dropSession(m.id);
  const file = path.join(sessionDir(m.id), "events-archive.jsonl");
  const before = fileSize(file);
  if (!before) return 0;
  // Rewrite line for line: the archive is paged by index, so every event keeps its place, only smaller.
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out = lines.map((l) => {
    try {
      return JSON.stringify(compactEvent(JSON.parse(l) as Json));
    } catch {
      return l;
    }
  });
  writeAtomic(file, out.join("\n") + "\n");
  return Math.max(0, before - fileSize(file));
}

/** Finished tasks' step logs keep their last steps; each step's detail is cut short. */
function pruneLedgers(): number {
  const dir = path.join(userHome(), "runtime", "ledger");
  const tasks = readJson<{ id: string; status: string }[]>(path.join(userHome(), "runtime", "tasks.json"), []);
  const finished = new Set((Array.isArray(tasks) ? tasks : []).filter((t) => ["done", "failed", "cancelled"].includes(t.status)).map((t) => t.id));
  let freed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  for (const n of names) {
    const id = n.replace(/\.json$/, "");
    if (!finished.has(id)) continue;
    const f = path.join(dir, n);
    const before = fileSize(f);
    const l = readJson<{ runs?: unknown[]; steps?: Json[] } | null>(f, null);
    if (!l || !Array.isArray(l.steps) || l.steps.length <= 20) continue;
    l.steps = l.steps.slice(-20).map(compactEvent);
    writeAtomic(f, JSON.stringify(l, null, 2));
    freed += Math.max(0, before - fileSize(f));
  }
  return freed;
}

function removeChat(m: SessionMeta): number {
  const bytes = usage().sessions[m.id] ?? 0;
  dropSession(m.id);
  deleteSession(m.id);
  return bytes;
}

/**
 * Free space until usage is at or below `target` bytes. Returns what was done, also appended to the prune log.
 * Each stage finishes its cheapest items before the next, more destructive stage starts.
 */
export function pruneTo(target: number, auto: boolean): PruneEntry[] {
  const done: PruneEntry[] = [];
  const over = () => reconcile().used > target;
  if (!over()) return done;
  const note = (kind: PruneEntry["kind"], m: SessionMeta | null, freed: number) => {
    if (freed > 0) done.push({ at: Date.now(), kind, sessionId: m?.id, title: m?.title, freed, auto });
  };
  try {
    for (const m of candidates()) {
      note("screenshots", m, pruneScreenshots(m));
      if (!over()) return done;
    }
    note("trajectory", null, pruneLedgers());
    if (!over()) return done;
    for (const m of candidates()) {
      note("trajectory", m, pruneTrajectory(m));
      if (!over()) return done;
    }
    for (const m of candidates()) {
      note("chat", m, removeChat(m));
      if (!over()) return done;
    }
    return done;
  } finally {
    log(done);
    invalidate();
  }
}

/** Auto-prune for the current user if it is on and usage is past PRUNE_AT. */
export function maybeAutoPrune(u: Usage = usage()): PruneEntry[] {
  const limit = storageLimit();
  if (!Number.isFinite(limit) || u.used < limit * PRUNE_AT || !getStorageSettings().autoPrune) return [];
  return pruneTo(Math.floor(limit * PRUNE_TO), true);
}

/** One-click "clear old chats": delete every unpinned, idle chat not used for `days` days. */
export function clearOldChats(days: number): PruneEntry[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const done: PruneEntry[] = [];
  for (const m of candidates()) {
    if (m.updatedAt >= cutoff) continue;
    done.push({ at: Date.now(), kind: "clear-old", sessionId: m.id, title: m.title, freed: removeChat(m), auto: false });
  }
  log(done);
  invalidate();
  return done;
}

/** Delete one chat (refused while it is running or pinned), logging what it freed. */
export function deleteChat(id: string): PruneEntry | { error: string; status: number } {
  const m = getMeta(id);
  if (!m) return { error: "No such chat.", status: 404 };
  if (chatBusy(m)) return { error: "That chat is running. Stop it first.", status: 409 };
  if (getStorageSettings().pinned.includes(id)) return { error: "That chat is pinned. Unpin it first.", status: 409 };
  const e: PruneEntry = { at: Date.now(), kind: "delete", sessionId: id, title: m.title, freed: removeChat(m), auto: false };
  log([e]);
  invalidate();
  return e;
}

export function describePrune(entries: PruneEntry[]): string {
  const freed = entries.reduce((s, e) => s + e.freed, 0);
  return entries.length ? `Freed ${fmtMB(freed)} (${entries.length} item${entries.length === 1 ? "" : "s"}).` : "Nothing needed pruning.";
}

// Background: after each periodic reconcile, auto-prune every account that has it on.
const gp = globalThis as unknown as { __swarmAutoPrune?: boolean };
if (!gp.__swarmAutoPrune) {
  gp.__swarmAutoPrune = true;
  onReconcile((uid, u) => {
    runAs(uid, () => maybeAutoPrune(u));
  });
}
startStorageReconciler();

