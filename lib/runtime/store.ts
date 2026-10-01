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

// Serialize writes per file so two async mutations cannot clobber each other.
const writeChains = new Map<string, Promise<void>>();

function writeJson(file: string, data: unknown, mode = 0o600): void {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
      fs.renameSync(tmp, file);
    });
  writeChains.set(file, next);
}

// ---- Tasks ----

export function loadTasks(): Task[] {
  const tasks = readJson<Task[]>(TASKS_FILE, []);
  return Array.isArray(tasks) ? tasks : [];
}

export function saveTasks(tasks: Task[]): void {
  writeJson(TASKS_FILE, tasks);
}

/** A tiny in-process mutex around read-modify-write on the task index. */
let taskLock: Promise<unknown> = Promise.resolve();
export function withTasks<T>(fn: (tasks: Task[]) => T | Promise<T>): Promise<T> {
  const run = taskLock.then(async () => fn(loadTasks()));
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

export function saveLedger(taskId: string, ledger: Ledger): void {
  writeJson(ledgerFile(taskId), ledger);
}

export function deleteLedger(taskId: string): void {
  fs.rmSync(ledgerFile(taskId), { force: true });
}

// ---- Artifacts ----

export function loadArtifacts(): Artifact[] {
  const a = readJson<Artifact[]>(ARTIFACTS_FILE, []);
  return Array.isArray(a) ? a : [];
}

export function saveArtifacts(artifacts: Artifact[]): void {
  writeJson(ARTIFACTS_FILE, artifacts);
}

let artifactLock: Promise<unknown> = Promise.resolve();
export function withArtifacts<T>(fn: (artifacts: Artifact[]) => T | Promise<T>): Promise<T> {
  const run = artifactLock.then(async () => fn(loadArtifacts()));
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