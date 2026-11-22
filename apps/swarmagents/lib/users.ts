/**
 * Local password user store for the login/signup routes.
 *
 * Users live in a JSON file next to the swarm board in the storage dir
 * (SWARM_HOME, /data, or tmp fallback — see lib/board/store.ts). Passwords
 * are stored as scrypt hashes with a random per-user salt (node:crypto,
 * no npm dependencies).
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { resolveStorageDir, isDirWritable } from "./board/store";
import { atomicWriteFile } from "./atomic-write";

const SCHEME = "scrypt";
const KEY_LEN = 32;
const SALT_BYTES = 16;

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
  maxmem?: number;
}

export const DEFAULT_SCRYPT_COST: ScryptCost = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
};

/** Async scrypt (promisified); never blocks the event loop while hashing. */
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer | string,
  keylen: number,
  options?: ScryptCost,
) => Promise<Buffer>;

/**
 * A fixed scrypt hash used to equalize the cost of a login attempt for an
 * unknown email. The stored value is never used for authentication — only its
 * parameters (identical to real hashes) matter, so known and unknown accounts
 * burn the same CPU before responding and account existence cannot be probed
 * by response timing.
 */
const DUMMY_SCRYPT_HASH =
  "scrypt$N=16384,r=8,p=1$33247306aac749054795c00127be0ecf$945ffa6bb3d59a4b3d46e77f8a6f5c1cb0bc5d549c017b4b5d9e90dd74a00ba9";
const MAX_EMAIL_LEN = 254;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 1024;

/** The identity a successful login yields; uid is stable and cookie-signed. */
export interface LocalUser {
  uid: string;
  email: string;
}

interface StoredUser {
  email: string;
  password: string; // scrypt$<salt hex>$<hash hex>
  createdAt: number;
  /**
   * Session epoch (Unix milliseconds) for this account: the time the user
   * last revoked all their sessions. A session cookie issued before this
   * time is invalid. Absent or 0 means never revoked (all sessions valid).
   * Milliseconds, not seconds: session issued-at is second-resolution, so
   * a second-resolution epoch would leave any session issued in the same
   * second as a revocation valid. Comparing issuedAt * 1000 against a
   * millisecond epoch closes that window; the trade-off is that a session
   * minted in the remainder of the same second *after* a revocation is
   * also rejected, and only a session from the next second onward is
   * accepted (a re-login a second later works).
   */
  sessionEpoch?: number;
}

interface UserFile {
  version: 1;
  users: StoredUser[];
}

/**
 * Thrown when the in-flight scrypt budget and its wait queue are both full.
 * Routes translate this to HTTP 429 so a burst of login/signup attempts is
 * shed instead of piling unbounded work onto the libuv thread pool.
 */
export class ScryptBusyError extends Error {
  constructor() {
    super("scrypt concurrency limit reached");
    this.name = "ScryptBusyError";
  }
}

export function isScryptBusyError(err: unknown): err is ScryptBusyError {
  return err instanceof ScryptBusyError;
}

function positiveInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nonNegativeInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Default: at most 4 scrypt derivations in flight (the libuv pool is 4). */
const DEFAULT_MAX_CONCURRENT_SCRYPT = 4;
/** Bounded wait queue: beyond this callers get 429 instead of an unbounded backlog. */
const DEFAULT_MAX_QUEUED_SCRYPT = 32;

let activeScrypt = 0;
const scryptWaiters: Array<() => void> = [];

/**
 * Acquire a scrypt slot. Returns immediately when under the cap; otherwise
 * waits in a bounded FIFO queue or throws ScryptBusyError when that is full.
 * The slot is handed directly from a finishing derivation to the next waiter,
 * so `activeScrypt` never exceeds the cap.
 */
async function acquireScryptSlot(): Promise<void> {
  const max = positiveInt("SWARM_SCRYPT_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENT_SCRYPT);
  const maxQueue = nonNegativeInt("SWARM_SCRYPT_MAX_QUEUE", DEFAULT_MAX_QUEUED_SCRYPT);
  if (activeScrypt < max) {
    activeScrypt++;
    return;
  }
  if (scryptWaiters.length >= maxQueue) throw new ScryptBusyError();
  await new Promise<void>((resolve) => scryptWaiters.push(resolve));
  // releaseScryptSlot transferred its slot to this waiter; active is unchanged.
}

function releaseScryptSlot(): void {
  const next = scryptWaiters.shift();
  if (next) next();
  else activeScrypt = Math.max(0, activeScrypt - 1);
}

/** Run one scrypt derivation under the global concurrency cap. */
async function withScryptSlot<T>(work: () => Promise<T>): Promise<T> {
  await acquireScryptSlot();
  try {
    return await work();
  } finally {
    releaseScryptSlot();
  }
}

/** Password hashing: versioned scrypt with cost parameters and random salt, async. */
export async function hashPassword(password: string, cost: ScryptCost = DEFAULT_SCRYPT_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await withScryptSlot(() => scryptAsync(password, salt, KEY_LEN, cost));
  return `${SCHEME}$N=${cost.N},r=${cost.r},p=${cost.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export interface ParsedScryptHash {
  versioned: boolean;
  cost: ScryptCost;
  salt: Buffer;
  hash: Buffer;
}

/**
 * Parse a stored hash string. Supports:
 * - Versioned 4-part: scrypt$N=...,r=...,p=...$<saltHex>$<hashHex>
 * - Legacy 3-part: scrypt$<saltHex>$<hashHex> (defaults to N=16384, r=8, p=1)
 */
export function parseScryptHash(stored: string): ParsedScryptHash | null {
  const parts = stored.split("$");
  if (parts[0] !== SCHEME) return null;
  if (parts.length === 3) {
    return {
      versioned: false,
      cost: { ...DEFAULT_SCRYPT_COST },
      salt: Buffer.from(parts[1], "hex"),
      hash: Buffer.from(parts[2], "hex"),
    };
  }
  if (parts.length === 4) {
    const cost: ScryptCost = { ...DEFAULT_SCRYPT_COST };
    for (const p of parts[1].split(",")) {
      const [k, v] = p.split("=");
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (k === "N") cost.N = n;
      else if (k === "r") cost.r = n;
      else if (k === "p") cost.p = n;
    }
    return {
      versioned: true,
      cost,
      salt: Buffer.from(parts[2], "hex"),
      hash: Buffer.from(parts[3], "hex"),
    };
  }
  return null;
}

/** Verify a password against a stored scrypt hash; async and constant-time. */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseScryptHash(stored);
  if (!parsed) return false;
  const actual = await withScryptSlot(() =>
    scryptAsync(password, parsed.salt, parsed.hash.length, parsed.cost),
  );
  return actual.length === parsed.hash.length && timingSafeEqualBuf(actual, parsed.hash);
}

/** In-process cache for the parsed users file, keyed by the file's stat identity. */
interface UsersCache {
  file: string;
  mtimeNs: bigint;
  size: bigint;
  users: StoredUser[];
  byEmail: Map<string, StoredUser>;
}

let usersCache: UsersCache | null = null;

function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The users file lives next to the swarm board in the same data dir. */
function resolveUserFile(): string {
  const home = process.env.SWARM_HOME;
  if (home && isDirWritable(home)) return path.join(home, "users.json");
  return path.join(resolveStorageDir(), "users.json");
}

let USER_FILE = resolveUserFile();

/** Point the store at a different file (tests). */
export function configureUserPaths(file: string): void {
  USER_FILE = file;
  usersCache = null;
}

/**
 * Read the parsed users, reusing the cached copy while the file's mtime and
 * size are unchanged. Stat-only hits avoid re-reading and re-parsing the JSON
 * on every login/signup/lookup. Every in-process write invalidates the cache,
 * and external edits are detected by the stat identity.
 */
function loadUsers(): StoredUser[] {
  try {
    const stat = fs.statSync(USER_FILE, { bigint: true });
    if (
      usersCache &&
      usersCache.file === USER_FILE &&
      usersCache.mtimeNs === stat.mtimeNs &&
      usersCache.size === stat.size
    ) {
      return usersCache.users;
    }
    const data = JSON.parse(fs.readFileSync(USER_FILE, "utf-8")) as UserFile;
    const users = Array.isArray(data.users) ? data.users : [];
    const byEmail = new Map<string, StoredUser>();
    for (const u of users) {
      byEmail.set(u.email, u);
    }
    usersCache = { file: USER_FILE, mtimeNs: stat.mtimeNs, size: stat.size, users, byEmail };
    return users;
  } catch {
    // Missing or corrupt file: treat as an empty store, never crash login.
    usersCache = null;
    return [];
  }
}

function findUserByEmail(email: string): StoredUser | undefined {
  loadUsers();
  return usersCache?.byEmail.get(email);
}

function saveUsers(users: StoredUser[]): void {
  fs.mkdirSync(path.dirname(USER_FILE), { recursive: true });
  // Random suffix as well as time+pid: two writes in the same millisecond
  // must not collide on the temp name (randomUUID, stronger than the
  // Math.random() suffix run-index.ts uses for the same purpose).
  atomicWriteFile(USER_FILE, JSON.stringify({ version: 1, users } satisfies UserFile, null, 2), { encoding: "utf-8", mode: 0o600 });
  // Invalidate after every write so the next read re-stats (and re-reads if
  // another process touched the file in the meantime).
  usersCache = null;
}

/** Normalize an email: lowercase, trimmed; returns "" when invalid. */
export function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") return "";
  const e = email.trim().toLowerCase();
  if (!e || e.length > MAX_EMAIL_LEN) return "";
  // Minimal sanity: one @ and no whitespace/control characters.
  if (!e.includes("@") || /[\s\u0000-\u001f\u007f]/.test(e)) return "";
  return e;
}

export type SignupError = "exists" | "invalid" | "busy" | "fatal";

export type SignupResult =
  | { ok: true; user: LocalUser }
  | { ok: false; error: SignupError };

/**
 * Serializes read-modify-write cycles on users.json within this process —
 * the same shape as the AsyncLock in lib/runtime/session-store.ts. Two
 * concurrent signups must not both load the same snapshot and have the
 * second write drop the first account.
 */
class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  async acquire<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = this.tail;
    let resolve!: () => void;
    this.tail = new Promise<void>((res) => {
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

const usersLock = new AsyncLock();

const LOCKFILE_STALE_MS = 5000;
const LOCKFILE_TIMEOUT_MS = 10000;

/**
 * Acquire a cross-process lockfile next to the users file using O_EXCL ('wx').
 * Implements stale-lock detection and automatic cleanup.
 */
async function withCrossProcessLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const lockfile = `${USER_FILE}.lock`;
  fs.mkdirSync(path.dirname(lockfile), { recursive: true });
  const start = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockfile, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockfile);
        if (Date.now() - stat.mtimeMs > LOCKFILE_STALE_MS) {
          try {
            fs.unlinkSync(lockfile);
          } catch {}
          continue;
        }
      } catch {}

      if (Date.now() - start > LOCKFILE_TIMEOUT_MS) {
        throw new Error("Timeout acquiring cross-process lock for users.json");
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockfile);
    } catch {}
  }
}

/** Combines in-process serialization and cross-process lockfile. */
export async function withUsersLock<T>(fn: () => T | Promise<T>): Promise<T> {
  return usersLock.acquire(() => withCrossProcessLock(fn));
}

/**
 * Create a local password user; fires no network calls.
 *
 * The scrypt hash runs outside the lock (hashing is pure computation, and
 * the scrypt concurrency cap must still shed overload exactly as before —
 * holding the lock across the hash would serialize derivations and change
 * that behaviour). The duplicate check and the write run inside the lock
 * against a freshly re-read snapshot, so two signups that hashed in
 * parallel cannot both persist, and a same-email second signup sees the
 * first one's write and reports "exists".
 */
export async function signupLocalUser(email: unknown, password: unknown): Promise<SignupResult> {
  const normalized = normalizeEmail(email);
  if (
    !normalized ||
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LEN ||
    password.length > MAX_PASSWORD_LEN
  ) {
    return { ok: false, error: "invalid" };
  }
  // Fast path for the obvious duplicate; the check inside the lock below is
  // the authoritative one.
  if (localUserExists(normalized)) {
    return { ok: false, error: "exists" };
  }
  let hashed: string;
  try {
    hashed = await hashPassword(password);
  } catch (err) {
    if (isScryptBusyError(err)) return { ok: false, error: "busy" };
    throw err;
  }
  return withUsersLock((): SignupResult => {
    // Re-read inside the critical section: a concurrent signup may have
    // persisted between this call's first load and the hash finishing.
    const users = loadUsers();
    if (users.some((u) => u.email === normalized)) {
      return { ok: false, error: "exists" };
    }
    // Never mutate the cached array: a failed write must not leak an account
    // into the in-memory store.
    const next = [...users, { email: normalized, password: hashed, createdAt: Date.now() }];
    try {
      saveUsers(next);
    } catch {
      return { ok: false, error: "fatal" };
    }
    return { ok: true, user: { uid: localUserIdForEmail(normalized), email: normalized } };
  });
}

/** The stable user id a local account signs in as (what the session cookie carries). */
export function localUserIdForEmail(email: string): string {
  return `local_${email}`;
}

/** Display email for a session user id: a local account's id is `local_<email>`, so strip the prefix. */
export function emailForUserId(userId: string): string {
  if (userId.startsWith("local_") && userId.includes("@")) return userId.slice("local_".length);
  return `${userId}@swarmagents.local`;
}

/**
 * Every local account's stable user id. Used to enumerate the known users when
 * the VM driver decides whether a legacy-named container/volume belongs to
 * exactly one owner (safe to migrate) or to several (ambiguous — leave it).
 */
export function listLocalUserIds(): string[] {
  return loadUsers().map((u) => localUserIdForEmail(u.email));
}

/** True when a local account exists for `email`. */
export function localUserExists(email: unknown): boolean {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && Boolean(findUserByEmail(normalized));
}

/**
 * Upgrade a user's stored password hash to the latest versioned scrypt format
 * if it was using a legacy format or different parameters. Best-effort and non-blocking.
 */
async function upgradeHashIfNeeded(email: string, password: string, storedHash: string): Promise<void> {
  const parsed = parseScryptHash(storedHash);
  if (
    parsed &&
    parsed.versioned &&
    parsed.cost.N === DEFAULT_SCRYPT_COST.N &&
    parsed.cost.r === DEFAULT_SCRYPT_COST.r &&
    parsed.cost.p === DEFAULT_SCRYPT_COST.p
  ) {
    return;
  }
  try {
    const upgraded = await hashPassword(password);
    await withUsersLock(() => {
      const users = loadUsers();
      const idx = users.findIndex((u) => u.email === email);
      if (idx >= 0) {
        const next = [...users];
        next[idx] = { ...next[idx], password: upgraded };
        saveUsers(next);
      }
    });
  } catch {
    // Non-fatal: login already succeeded
  }
}

/** Verify a local password; returns the user on success, null otherwise. Transparently upgrades hash if needed. */
export async function verifyLocalUser(email: unknown, password: unknown): Promise<LocalUser | null> {
  const normalized = normalizeEmail(email);
  if (!normalized || typeof password !== "string" || !password) return null;
  const user = findUserByEmail(normalized);
  if (!user) {
    // Burn the same scrypt cost as a real verification against a fixed dummy
    // hash, so an unknown email is indistinguishable from a wrong password by
    // response timing (no account enumeration).
    await verifyPassword(password, DUMMY_SCRYPT_HASH);
    return null;
  }
  if (!(await verifyPassword(password, user.password))) return null;

  void upgradeHashIfNeeded(normalized, password, user.password).catch(() => {});

  return { uid: localUserIdForEmail(normalized), email: normalized };
}

/**
 * Current session epoch counter for a local account — 0 when the account has
 * never revoked sessions. Each revocation increments this counter monotonically.
 */
export function getSessionEpoch(email: unknown): number {
  const normalized = normalizeEmail(email);
  if (!normalized) return 0;
  const user = findUserByEmail(normalized);
  return user?.sessionEpoch ?? 0;
}

/**
 * Revoke every existing session for a local account by raising its session
 * epoch to now (Unix milliseconds). Returns true when the account exists and
 * was updated; false for an unknown account or a write failure. Serialized through
 * the cross-process lock.
 */
export async function bumpSessionEpoch(email: unknown): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return withUsersLock((): boolean => {
    const users = loadUsers();
    const idx = users.findIndex((u) => u.email === normalized);
    if (idx < 0) return false;
    const now = Date.now();
    const next = users.map((u, i) => (i === idx ? { ...u, sessionEpoch: now } : u));
    try {
      saveUsers(next);
      return true;
    } catch {
      return false;
    }
  });
}
