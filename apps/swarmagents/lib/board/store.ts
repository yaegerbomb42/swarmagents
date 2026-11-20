import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { atomicWriteFile, atomicWriteFileAsync } from "../atomic-write";
import type { BoardStore } from "./types";

export interface StorageHealth {
  path: string;
  dataFile: string;
  writable: boolean;
}

/**
 * Raised when the board file exists but cannot be read for an environmental
 * reason (permissions, too many open files, memory pressure, …). This is NOT
 * corruption: the bytes on disk may be perfectly valid, so callers must retry
 * instead of treating the board as empty. `saveStoreAtomic` refuses to write
 * while this is the last known read state, so a transient I/O fault can never
 * turn into "all tasks disappeared".
 */
export class BoardUnavailableError extends Error {
  readonly code = "BOARD_UNAVAILABLE" as const;
  readonly retryable = true as const;
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BoardUnavailableError";
    this.cause = options?.cause;
  }
}

/**
 * Probe-write a marker file to prove a directory is actually writable, not
 * merely present. mkdir + writeFile would only fail later, mid-save; probing
 * up front turns an unwritable SWARM_HOME into a loud, immediate decision
 * point instead of a silently lost board.
 */
export function isDirWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.swarm_write_probe_${process.pid}_${Date.now()}`);
    fs.writeFileSync(probe, "probe");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a writable data directory for the swarm board.
 * Resolution order: SWARM_HOME -> ~/.swarmagents -> /data -> os.tmpdir().
 * Falling back to the temp dir keeps the app functional (in-memory reads and
 * writes still work for the lifetime of the process) but board state is LOST
 * on restart, so that fallback must be loud.
 */
export function resolveStorageDir(): string {
  const home = process.env.SWARM_HOME;
  if (home) {
    if (isDirWritable(home)) {
      return home;
    }
    console.error(
      `[swarm-board] WARNING: SWARM_HOME=${home} is not writable; falling back to /data`
    );
  }
  // Keep the historical default first so an existing deployment's board is not orphaned.
  const legacy = path.join(os.homedir(), ".swarmagents");
  if (isDirWritable(legacy)) {
    return legacy;
  }
  if (isDirWritable("/data")) {
    return "/data";
  }
  const fallback = path.join(os.tmpdir(), "swarmagents");
  console.error(
    `[swarm-board] WARNING: no writable persistent data dir (SWARM_HOME, /data). ` +
      `Using temporary directory ${fallback}; board state will be LOST on restart. ` +
      `Mount a volume and set SWARM_HOME to persist tasks.`
  );
  return fallback;
}

let STORAGE_DIR = resolveStorageDir();
let DATA_FILE = path.join(STORAGE_DIR, "swarm_board.json");

/**
 * Last read state, shared by loadStore() and saveStoreAtomic():
 *
 *   - `readFailure` is set when the last read failed for an I/O reason (not
 *     because the file was absent). While set, saving refuses to run: writing
 *     the in-memory (empty or stale) store over a file we could not read is
 *     exactly the data-loss bug this module guards against.
 *   - `loadSucceeded` records whether a load actually produced a usable view
 *     (including a deliberate, archived corruption decision). The empty-board
 *     overwrite guard below needs it.
 */
let readFailure: BoardUnavailableError | null = null;
let loadSucceeded = false;

export function configureStorePaths(storageDir: string, dataFile: string) {
  STORAGE_DIR = storageDir;
  DATA_FILE = dataFile;
  readFailure = null;
  loadSucceeded = false;
}

export function getStoragePaths() {
  return { STORAGE_DIR, DATA_FILE };
}

export function getStorageHealth(): StorageHealth {
  return {
    path: STORAGE_DIR,
    dataFile: DATA_FILE,
    writable: isDirWritable(STORAGE_DIR),
  };
}

function emptyStore(): BoardStore {
  return { tasks: [], proposals: [], messages: [], leaderboard: [], matches: [] };
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * File-descriptor pressure (EMFILE/ENFILE) and transient kernel/FS
 * contentions (EAGAIN/EBUSY/ETIMEDOUT/EINTR) are worth retrying: the bytes on
 * disk are fine, the process just could not get to them this instant. Every
 * other fs error (EACCES, EISDIR, ENOMEM, EIO, …) is reported immediately —
 * retrying a permission error only adds latency before the same conclusion.
 */
const TRANSIENT_IO_CODES: ReadonlySet<string> = new Set([
  "EMFILE",
  "ENFILE",
  "EAGAIN",
  "EWOULDBLOCK",
  "EBUSY",
  "ETIMEDOUT",
  "EINTR",
]);

const READ_ATTEMPTS = 4;
const READ_BACKOFF_MS = 15;

/** Synchronous sleep so loadStore() stays a drop-in sync API for callers. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

/**
 * Read the board file with bounded exponential backoff for transient I/O
 * errors. A missing file is an empty board, not an error. Throws the raw fs
 * error once retries are exhausted so the caller can classify it.
 */
function readBoardBytes(file: string): Buffer | null {
  let lastError: unknown;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    try {
      return fs.readFileSync(file);
    } catch (err) {
      const code = errorCode(err);
      if (code === "ENOENT") return null;
      if (!code || !TRANSIENT_IO_CODES.has(code)) throw err;
      lastError = err;
      if (attempt < READ_ATTEMPTS - 1) sleepSync(READ_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoardShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  // Older files may omit collections. A present-but-invalid collection
  // (including a null/primitive entry) is corruption, not an empty list.
  for (const key of ["tasks", "proposals", "messages", "leaderboard", "matches", "artifacts"]) {
    const field = value[key];
    if (field !== undefined && (!Array.isArray(field) || !field.every(isRecord))) return false;
  }
  return true;
}

/**
 * Archive the exact bytes that failed to parse without moving the live file.
 * Identical bad bytes have one archive: a polling worker must not copy the
 * same corruption indefinitely and eventually fill the disk.
 */
function archiveCorruptBytes(bytes: Buffer, reason: string): void {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const archivePath = `${DATA_FILE}.corrupt-${hash}`;
  try {
    if (fs.existsSync(archivePath) && bytes.equals(fs.readFileSync(archivePath))) return;
    atomicWriteFile(archivePath, bytes);
    console.error(`[swarm-board] board file is corrupt (${reason}); archived to ${archivePath}`);
  } catch (err) {
    // Could not keep a copy: leave the original in place and refuse all saves
    // (readFailure survives until a later load succeeds) so a future write
    // cannot overwrite the only remaining evidence.
    const unavailable = new BoardUnavailableError(
      `Board file could not be parsed (${reason}) and could not be archived: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err }
    );
    readFailure = unavailable;
    loadSucceeded = false;
    throw unavailable;
  }
}

export function loadStore(): BoardStore {
  let bytes: Buffer | null;
  try {
    bytes = readBoardBytes(DATA_FILE);
  } catch (err) {
    // Do NOT rename or write anything here. The file is likely valid; it is
    // the environment that cannot read it right now.
    const unavailable = new BoardUnavailableError(
      `Board storage is temporarily unavailable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
    readFailure = unavailable;
    loadSucceeded = false;
    throw unavailable;
  }

  // Restrict the corruption decision to JSON.parse/shape failure below; any
  // I/O incident thrown from here on is an archival failure, not corruption.
  if (bytes === null) {
    readFailure = null;
    loadSucceeded = true;
    return emptyStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    archiveCorruptBytes(bytes, "invalid JSON or UTF-8");
    readFailure = null;
    loadSucceeded = true;
    return emptyStore();
  }

  if (!isBoardShape(parsed)) {
    archiveCorruptBytes(bytes, "unexpected board shape");
    readFailure = null;
    loadSucceeded = true;
    return emptyStore();
  }

  readFailure = null;
  loadSucceeded = true;
  const data = parsed;
  return {
    tasks: Array.isArray(data.tasks) ? (data.tasks as BoardStore["tasks"]) : [],
    proposals: Array.isArray(data.proposals) ? (data.proposals as BoardStore["proposals"]) : [],
    messages: Array.isArray(data.messages) ? (data.messages as BoardStore["messages"]) : [],
    // Arena fields are optional (backward-compatible); normalize legacy ratings
    // so a hand-edited or pre-arena board never breaks the leaderboard math.
    leaderboard: Array.isArray(data.leaderboard)
      ? (data.leaderboard as BoardStore["leaderboard"])
      : [],
    matches: Array.isArray(data.matches) ? (data.matches as BoardStore["matches"]) : [],
    ...(Array.isArray(data.artifacts) ? { artifacts: data.artifacts as BoardStore["artifacts"] } : {}),
  };
}

class AsyncLock {
  private promise: Promise<void> = Promise.resolve();
  async acquire<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = this.promise;
    let resolve!: () => void;
    this.promise = new Promise<void>((res) => {
      resolve = res;
    });
    await release;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}

// Next can bundle the MCP route, chat route and team writer separately.
// Share one load/modify/save lock across their module instances in this
// process. This JSON store is not a multi-process database.
const globals = globalThis as typeof globalThis & { __swarmBoardStoreLock?: AsyncLock };
const storeLock = (globals.__swarmBoardStoreLock ??= new AsyncLock());

export async function withLockedStore<T>(fn: (store: BoardStore) => T | Promise<T>): Promise<T> {
  return storeLock.acquire(async () => {
    const store = loadStore();
    return fn(store);
  });
}

function isEmptyStore(store: BoardStore): boolean {
  return (
    store.tasks.length === 0 &&
    store.proposals.length === 0 &&
    store.messages.length === 0 &&
    (store.artifacts?.length ?? 0) === 0 &&
    (store.matches?.length ?? 0) === 0 &&
    (store.leaderboard?.length ?? 0) === 0
  );
}

/** True when a non-zero-length board file already exists. */
function existingFileHasBytes(): boolean {
  try {
    return fs.statSync(DATA_FILE).size > 0;
  } catch {
    return false;
  }
}

export async function saveStoreAtomic(store: BoardStore): Promise<void> {
  // A read that failed for I/O reasons means we do not know what is on disk.
  // Writing over it could destroy a perfectly valid board.
  if (readFailure) {
    throw new BoardUnavailableError(
      "Refusing to save the board while the last read failed; retry after storage recovers.",
      { cause: readFailure }
    );
  }
  // Belt-and-braces: never replace an existing non-empty board with an empty
  // one unless a load actually succeeded first. Without this, a caller that
  // constructed an empty store from stale state could erase the board.
  if (!loadSucceeded && isEmptyStore(store) && existingFileHasBytes()) {
    throw new BoardUnavailableError(
      "Refusing to overwrite an existing board with an empty board because no successful load preceded this save."
    );
  }

  await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
  await atomicWriteFileAsync(DATA_FILE, JSON.stringify(store, null, 2), { encoding: "utf-8" });
  // The store we just wrote is now the known-good on-disk state.
  loadSucceeded = true;
}
