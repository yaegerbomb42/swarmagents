// Durable storage for the runtime control plane.
//
// Layout under $SWARM_HOME (default ~/.swarmagents):
//   runtime/tasks.json     - the task index (all tasks, small records)
//   runtime/ledger/<id>.json  - per-task run + step history, kept out of the hot file
//   runtime/artifacts.json - artifact index (payloads live where the agent wrote them)
//   runtime/settings.json  - runtime settings
//
// Writes are atomic (tmp + rename) and use a per-process queue so concurrent async
// callers never interleave. Reads are tolerant: a corrupt file degrades to a default
// rather than taking the whole runtime down.

import fs from "node:fs";
import path from "node:path";
import { HOME, newId } from "../store";
import {
  DEFAULT_RUNTIME_SETTINGS,
  type Artifact,
  type RuntimeSettings,
  type RunRecord,
  type StepRecord,
  type Task,
} from "./types";

export const RUNTIME_DIR = path.join(HOME, "runtime");
const LEDGER_DIR = path.join(RUNTIME_DIR, "ledger");
const TASKS_FILE = path.join(RUNTIME_DIR, "tasks.json");
const ARTIFACTS_FILE = path.join(RUNTIME_DIR, "artifacts.json");
const SETTINGS_FILE = path.join(RUNTIME_DIR, "settings.json");

fs.mkdirSync(LEDGER_DIR, { recursive: true, mode: 0o700 });

export const rtId = () => newId();

function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Serialize writes per file so two async mutations cannot clobber each other. Each call
// returns a promise the caller can await: durability matters more than latency here, and
// callers that fire-and-forget still get a clean chain.
const writeChains = new Map<string, Promise<void>>();

function writeJson(file: string, data: unknown, mode = 0o600): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
      fs.renameSync(tmp, file);
    });
  writeChains.set(file, next);
  return next;
}

/** Await every write scheduled so far. Used by tests and graceful shutdown. */
export function flushWrites(): Promise<void> {
  return Promise.all([...writeChains.values()]).then(() => undefined);
}

// ---- Tasks ----

export function loadTasks(): Task[] {
  const tasks = readJson<Task[]>(TASKS_FILE, []);
  return Array.isArray(tasks) ? tasks : [];
}

export function saveTasks(tasks: Task[]): Promise<void> {
  return writeJson(TASKS_FILE, tasks);
}

/** A tiny in-process mutex around read-modify-write on the task index. The mutation is
 *  persisted before the promise resolves, so a caller that awaited a change can rely on
 *  it surviving a crash. */
let taskLock: Promise<unknown> = Promise.resolve();
export function withTasks<T>(fn: (tasks: Task[]) => T | Promise<T>): Promise<T> {
  const run = taskLock.then(async () => {
    const tasks = loadTasks();
    const result = await fn(tasks);
    await saveTasks(tasks);
    return result;
  });
  // Keep the chain alive even if fn throws, but surface errors to the caller.
  taskLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- Ledger (runs + steps) ----

export interface Ledger {
  runs: RunRecord[];
  steps: StepRecord[];
}

const ledgerFile = (taskId: string) => path.join(LEDGER_DIR, `${taskId}.json`);

export function loadLedger(taskId: string): Ledger {
  const l = readJson<Ledger>(ledgerFile(taskId), { runs: [], steps: [] });
  return { runs: Array.isArray(l.runs) ? l.runs : [], steps: Array.isArray(l.steps) ? l.steps : [] };
}

export function saveLedger(taskId: string, ledger: Ledger): Promise<void> {
  return writeJson(ledgerFile(taskId), ledger);
}

export function deleteLedger(taskId: string): void {
  fs.rmSync(ledgerFile(taskId), { force: true });
}

// Per-task ledger mutex: read-modify-write with the write awaited, so concurrent turn/tool
// recordings never lose each other and a caller that awaited can trust the record exists.
const ledgerLocks = new Map<string, Promise<unknown>>();
export function withLedger<T>(taskId: string, fn: (ledger: Ledger) => T | Promise<T>): Promise<T> {
  const prev = ledgerLocks.get(taskId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const ledger = loadLedger(taskId);
    const result = await fn(ledger);
    await saveLedger(taskId, ledger);
    return result;
  });
  ledgerLocks.set(
    taskId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ---- Artifacts ----

export function loadArtifacts(): Artifact[] {
  const a = readJson<Artifact[]>(ARTIFACTS_FILE, []);
  return Array.isArray(a) ? a : [];
}

export function saveArtifacts(artifacts: Artifact[]): Promise<void> {
  return writeJson(ARTIFACTS_FILE, artifacts);
}

let artifactLock: Promise<unknown> = Promise.resolve();
export function withArtifacts<T>(fn: (artifacts: Artifact[]) => T | Promise<T>): Promise<T> {
  const run = artifactLock.then(async () => {
    const artifacts = loadArtifacts();
    const result = await fn(artifacts);
    await saveArtifacts(artifacts);
    return result;
  });
  artifactLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- Settings ----

export function loadRuntimeSettings(): RuntimeSettings {
  return { ...DEFAULT_RUNTIME_SETTINGS, ...readJson<Partial<RuntimeSettings>>(SETTINGS_FILE, {}) };
}

export function saveRuntimeSettings(s: RuntimeSettings): void {
  writeJson(SETTINGS_FILE, s);
}

// ---- Action approvals ----
//
// A grant lets one specific already-classified action run without asking again. It is bound to the
// action hash, is single-use, and expires, so a stale approval cannot authorise a different command.

const APPROVALS_FILE = path.join(RUNTIME_DIR, "approvals.json");

/**
 * How long an approval stays valid. A resume normally consumes the grant within seconds; the window
 * exists so a grant made just before a restart or a long tool step still counts, while an approval the
 * user gave hours ago cannot silently authorise the same action deep into an unattended 24h+ run.
 */
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

export interface ApprovalGrant {
  taskId: string;
  hash: string;
  tool: string;
  /** Human-readable action, shown in the ledger when the grant is used. */
  label: string;
  grantedAt: number;
}

function approvalsKey(taskId: string, hash: string): string {
  return `${taskId}:${hash}`;
}

export function loadApprovals(): Record<string, ApprovalGrant> {
  return readJson<Record<string, ApprovalGrant>>(APPROVALS_FILE, {});
}

/** Record a single-use approval for an exact action. */
export function grantApproval(g: ApprovalGrant): Promise<void> {
  const all = loadApprovals();
  all[approvalsKey(g.taskId, g.hash)] = g;
  return writeJson(APPROVALS_FILE, all);
}

/** Consume an approval if one exists for this action and has not expired. Returns the grant, or null. */
export function takeApproval(taskId: string, hash: string): ApprovalGrant | null {
  const all = loadApprovals();
  const key = approvalsKey(taskId, hash);
  const g = all[key];
  if (!g) return null;
  delete all[key];
  void writeJson(APPROVALS_FILE, all);
  // Consumed either way (single-use). An expired grant returns null so the caller re-parks and asks
  // again: the safe default when the user is no longer watching.
  if (Date.now() - g.grantedAt > APPROVAL_TTL_MS) return null;
  return g;
}

/** Drop every pending approval for a task (on cancel/delete/finish). */
export function clearApprovals(taskId: string): void {
  const all = loadApprovals();
  let changed = false;
  for (const k of Object.keys(all)) {
    if (all[k].taskId === taskId) {
      delete all[k];
      changed = true;
    }
  }
  if (changed) void writeJson(APPROVALS_FILE, all);
}

// ---- Action denials ----
//
// A denial is durable for the life of the task: it tells the agent "the user said no to this exact
// action, do not ask again or find a way around it". Without it, a resumed run would simply re-propose
// the same call and block again forever.

const DENIALS_FILE = path.join(RUNTIME_DIR, "denials.json");

export interface DenialRecord {
  taskId: string;
  hash: string;
  tool: string;
  label: string;
  deniedAt: number;
}

function denialsKey(taskId: string, hash: string): string {
  return `${taskId}:${hash}`;
}

export function recordDenial(d: DenialRecord): Promise<void> {
  const all = readJson<Record<string, DenialRecord>>(DENIALS_FILE, {});
  all[denialsKey(d.taskId, d.hash)] = d;
  return writeJson(DENIALS_FILE, all);
}

export function isDenied(taskId: string, hash: string): boolean {
  return !!readJson<Record<string, DenialRecord>>(DENIALS_FILE, {})[denialsKey(taskId, hash)];
}

export function clearDenials(taskId: string): void {
  const all = readJson<Record<string, DenialRecord>>(DENIALS_FILE, {});
  let changed = false;
  for (const k of Object.keys(all)) {
    if (all[k].taskId === taskId) {
      delete all[k];
      changed = true;
    }
  }
  if (changed) void writeJson(DENIALS_FILE, all);
}