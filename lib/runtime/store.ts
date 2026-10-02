// Durable storage for the runtime control plane.
//
// Layout under the current user's home (userHome()/runtime):
//   runtime/tasks.json     - the task index (all tasks, small records)
//   runtime/ledger/<id>.json  - per-task run + step history, kept out of the hot file
//   runtime/artifacts.json - artifact index (payloads live where the agent wrote them)
//   runtime/settings.json  - runtime settings
//
// Writes are atomic (tmp + rename) and use a per-file queue so concurrent async
// callers never interleave. Reads are tolerant: a corrupt file degrades to a default
// rather than taking the whole runtime down. Every path resolves per user on each call,
// so on a server no account can see another's tasks, ledger, artifacts or approvals.

import fs from "node:fs";
import path from "node:path";
import { newId, userHome } from "../store";
import {
  DEFAULT_RUNTIME_SETTINGS,
  type Artifact,
  type RuntimeSettings,
  type RunRecord,
  type StepRecord,
  type Task,
} from "./types";

// Paths resolve against the current user's home on every call, never at module load: on a server
// every account must see only its own tasks, ledger, artifacts and approvals. Each helper is
// called inside a runAs()/scoped() context, so userHome() is that user's directory.
export const runtimeDir = () => path.join(userHome(), "runtime");
const ledgerDir = () => path.join(runtimeDir(), "ledger");
const tasksFile = () => path.join(runtimeDir(), "tasks.json");
const artifactsFile = () => path.join(runtimeDir(), "artifacts.json");
const settingsFile = () => path.join(runtimeDir(), "settings.json");
const approvalsFile = () => path.join(runtimeDir(), "approvals.json");
const denialsFile = () => path.join(runtimeDir(), "denials.json");

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
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
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
  const tasks = readJson<Task[]>(tasksFile(), []);
  return Array.isArray(tasks) ? tasks : [];
}

export function saveTasks(tasks: Task[]): Promise<void> {
  return writeJson(tasksFile(), tasks);
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

/**
 * Steps live in their own append-only file, not in the ledger JSON.
 *
 * A 24h+ run records tens of thousands of steps. Rewriting the whole ledger on every turn/tool
 * is O(n²) write amplification (measured: ~1.8 GB of writes for 3k steps) and would thrash the
 * server disk. Appending one line per step is O(1); the runs (small, mutated rarely) stay in the
 * JSON file. loadLedger merges the two so callers still see one {runs, steps} shape.
 */
const ledgerFile = (taskId: string) => path.join(ledgerDir(), `${taskId}.json`);
const stepsFile = (taskId: string) => path.join(ledgerDir(), `${taskId}.steps.ndjson`);

/** How many of the most recent steps we keep in memory (and serve). Older lines are compacted away. */
const STEP_KEEP = 5000;
/** Compact the steps file back to STEP_KEEP lines once it has grown this many lines past the cap. */
const STEP_COMPACT_AT = STEP_KEEP + 2000;

// Per-path cache of the last STEP_KEEP steps, so Activity reads are O(1) instead of re-reading a
// multi-MB file, and appends update it without a disk round-trip. Keyed by resolved file path so
// accounts never share state.
const stepCache = new Map<string, StepRecord[]>();

function readSteps(taskId: string): StepRecord[] {
  const file = stepsFile(taskId);
  const cached = stepCache.get(file);
  if (cached) return cached;
  const steps: StepRecord[] = [];
  try {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          steps.push(JSON.parse(line) as StepRecord);
        } catch {
          // A torn final line (crash mid-append) is skipped; earlier lines are intact.
        }
      }
    }
  } catch {
    // Unreadable steps file: behave as if empty rather than failing the whole ledger read.
  }
  const trimmed = steps.length > STEP_KEEP ? steps.slice(-STEP_KEEP) : steps;
  stepCache.set(file, trimmed);
  return trimmed;
}

export function loadLedger(taskId: string): Ledger {
  // Runs live in the JSON file; a legacy file may still carry an inline steps array — honor it.
  const l = readJson<Ledger>(ledgerFile(taskId), { runs: [], steps: [] });
  const runs = Array.isArray(l.runs) ? l.runs : [];
  const legacySteps = Array.isArray(l.steps) ? l.steps : [];
  const steps = readSteps(taskId);
  return { runs, steps: legacySteps.length > 0 ? [...legacySteps, ...steps].slice(-STEP_KEEP) : steps };
}

/** Persist just the runs (the runner metadata). Steps are appended separately — never written here. */
export function saveLedger(taskId: string, ledger: Ledger): Promise<void> {
  return writeJson(ledgerFile(taskId), { runs: ledger.runs });
}

/**
 * Append one step durably (one line, O(1)). Updates the in-memory cache synchronously so a reader
 * in the same process sees it immediately, and compacts rarely (amortized O(1)) so the file and
 * the cache stay bounded on a run that never ends.
 */
export function appendStep(taskId: string, rec: StepRecord): Promise<void> {
  const file = stepsFile(taskId);
  const cache = stepCache.get(file);
  if (cache) {
    cache.push(rec);
    if (cache.length > STEP_KEEP) cache.splice(0, cache.length - STEP_KEEP);
  } else {
    // First touch of this task in this process: load existing lines so a later read is complete.
    readSteps(taskId).push(rec);
    const c = stepCache.get(file);
    if (c && c.length > STEP_KEEP) c.splice(0, c.length - STEP_KEEP);
  }
  return new Promise<void>((resolve) => {
    fs.mkdirSync(ledgerDir(), { recursive: true });
    fs.appendFile(file, JSON.stringify(rec) + "\n", (err) => {
      if (err) {
        // A failed append must not wedge the run; the step is still in the in-memory cache.
        resolve();
        return;
      }
      resolve();
      void maybeCompactSteps(taskId, file);
    });
  });
}

let compacting = new Set<string>();
async function maybeCompactSteps(taskId: string, file: string): Promise<void> {
  if (compacting.has(file)) return;
  let lines = 0;
  try {
    const buf = await fs.promises.readFile(file, "utf8");
    lines = buf.length === 0 ? 0 : buf.split("\n").length - 1;
  } catch {
    return;
  }
  if (lines <= STEP_COMPACT_AT) return;
  compacting.add(file);
  try {
    const steps = stepCache.get(file) ?? readSteps(taskId);
    const kept = steps.slice(-STEP_KEEP);
    const tmp = file + ".tmp";
    await fs.promises.writeFile(tmp, kept.map((s) => JSON.stringify(s) + "\n").join(""));
    await fs.promises.rename(tmp, file);
    stepCache.set(file, kept);
  } catch {
    // Compaction is best-effort; the log stays correct (just longer) if it fails.
  } finally {
    compacting.delete(file);
  }
}

export function deleteLedger(taskId: string): void {
  fs.rmSync(ledgerFile(taskId), { force: true });
  fs.rmSync(stepsFile(taskId), { force: true });
  stepCache.delete(stepsFile(taskId));
}

// Per-task ledger mutex keyed by the resolved file path, so identical task ids under different
// accounts never share a lock. Read-modify-write with the write awaited, so concurrent turn/tool
// recordings never lose each other and a caller that awaited can trust the record exists.
const ledgerLocks = new Map<string, Promise<unknown>>();
export function withLedger<T>(taskId: string, fn: (ledger: Ledger) => T | Promise<T>): Promise<T> {
  const file = ledgerFile(taskId);
  const prev = ledgerLocks.get(file) ?? Promise.resolve();
  const run = prev.then(async () => {
    const ledger = loadLedger(taskId);
    const result = await fn(ledger);
    await saveLedger(taskId, ledger);
    return result;
  });
  ledgerLocks.set(
    file,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ---- Artifacts ----

export function loadArtifacts(): Artifact[] {
  const a = readJson<Artifact[]>(artifactsFile(), []);
  return Array.isArray(a) ? a : [];
}

export function saveArtifacts(artifacts: Artifact[]): Promise<void> {
  return writeJson(artifactsFile(), artifacts);
}

// Per-file artifact lock: each user serializes only their own artifacts.json.
const artifactLocks = new Map<string, Promise<unknown>>();
export function withArtifacts<T>(fn: (artifacts: Artifact[]) => T | Promise<T>): Promise<T> {
  const file = artifactsFile();
  const prev = artifactLocks.get(file) ?? Promise.resolve();
  const run = prev.then(async () => {
    const artifacts = loadArtifacts();
    const result = await fn(artifacts);
    await saveArtifacts(artifacts);
    return result;
  });
  artifactLocks.set(
    file,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ---- Settings ----

export function loadRuntimeSettings(): RuntimeSettings {
  return { ...DEFAULT_RUNTIME_SETTINGS, ...readJson<Partial<RuntimeSettings>>(settingsFile(), {}) };
}

export function saveRuntimeSettings(s: RuntimeSettings): void {
  writeJson(settingsFile(), s);
}

// ---- Action approvals ----
//
// A grant lets one specific already-classified action run without asking again. It is bound to the
// action hash, is single-use, and expires, so a stale approval cannot authorise a different command.

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

// Grants/denials are read-modify-written synchronously (takeApproval must be single-use even when it
// is called without awaiting a flush), so the map is the source of truth and writes only persist it.
// One cache per file: on a server each account has its own approvals.json, so we must not share a
// single in-memory map across users.
const approvalsCache = new Map<string, Record<string, ApprovalGrant>>();
function approvals(): Record<string, ApprovalGrant> {
  const file = approvalsFile();
  let cache = approvalsCache.get(file);
  if (!cache) {
    cache = readJson<Record<string, ApprovalGrant>>(file, {});
    approvalsCache.set(file, cache);
  }
  return cache;
}

export function loadApprovals(): Record<string, ApprovalGrant> {
  return approvals();
}

/** Record a single-use approval for an exact action. */
export function grantApproval(g: ApprovalGrant): Promise<void> {
  approvals()[approvalsKey(g.taskId, g.hash)] = g;
  return writeJson(approvalsFile(), approvals());
}

/** Consume an approval if one exists for this action and has not expired. Returns the grant, or null. */
export function takeApproval(taskId: string, hash: string): ApprovalGrant | null {
  const all = approvals();
  const key = approvalsKey(taskId, hash);
  const g = all[key];
  if (!g) return null;
  delete all[key];
  void writeJson(approvalsFile(), all);
  // Consumed either way (single-use). An expired grant returns null so the caller re-parks and asks
  // again: the safe default when the user is no longer watching.
  if (Date.now() - g.grantedAt > APPROVAL_TTL_MS) return null;
  return g;
}

/** Drop every pending approval for a task (on cancel/delete/finish). */
export function clearApprovals(taskId: string): void {
  const all = approvals();
  let changed = false;
  for (const k of Object.keys(all)) {
    if (all[k].taskId === taskId) {
      delete all[k];
      changed = true;
    }
  }
  if (changed) void writeJson(approvalsFile(), all);
}

// ---- Action denials ----
//
// A denial is durable for the life of the task: it tells the agent "the user said no to this exact
// action, do not ask again or find a way around it". Without it, a resumed run would simply re-propose
// the same call and block again forever.

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

const denialsCache = new Map<string, Record<string, DenialRecord>>();
function denials(): Record<string, DenialRecord> {
  const file = denialsFile();
  let cache = denialsCache.get(file);
  if (!cache) {
    cache = readJson<Record<string, DenialRecord>>(file, {});
    denialsCache.set(file, cache);
  }
  return cache;
}

export function recordDenial(d: DenialRecord): Promise<void> {
  denials()[denialsKey(d.taskId, d.hash)] = d;
  return writeJson(denialsFile(), denials());
}

export function isDenied(taskId: string, hash: string): boolean {
  return !!denials()[denialsKey(taskId, hash)];
}

export function clearDenials(taskId: string): void {
  const all = denials();
  let changed = false;
  for (const k of Object.keys(all)) {
    if (all[k].taskId === taskId) {
      delete all[k];
      changed = true;
    }
  }
  if (changed) void writeJson(denialsFile(), all);
}