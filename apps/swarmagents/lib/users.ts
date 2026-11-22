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
import { createHmac, randomBytes, randomUUID, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { resolveStorageDir, isDirWritable } from "./board/store";
import { atomicWriteFile } from "./atomic-write";
import { acquireFileLock } from "./file-lock";

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
  /**
   * Pending password-reset token (FIX-39): only the HMAC of the token is
   * stored, never the token itself, so a leaked users.json cannot be used
   * to reset anyone's password. Single-use: consumePasswordResetToken
   * clears this field on success (and on expiry), and issuing a new token
   * overwrites it, killing any earlier reset link. Absent means no reset
   * is in flight.
   */
  passwordReset?: {
    /** HMAC-SHA256 (hex) of the raw token, keyed by SWARM_SESSION_SECRET. */
    tokenHash: string;
    /** Unix milliseconds after which the token is dead. */
    expiresAt: number;
  };
  /**
   * Email-verification state (FIX-44). `false` = the account signed up
   * after verification shipped and has not yet clicked the emailed link;
   * in server mode such an account cannot start runs (it consumes no VM
   * compute until verified). Absent means the account predates
   * verification (or was created by an operator path) and is treated as
   * verified — grandfathered, so existing deployments do not lock out
   * their current users when this lands.
   */
  verified?: boolean;
  /**
   * Pending email-verification token (FIX-44): only the HMAC of the token
   * is stored, same construction as passwordReset but a distinct HMAC
   * domain, so a reset token can never verify an email or vice versa.
   * Single-use; issuing a new token overwrites it.
   */
  emailVerification?: {
    /** HMAC-SHA256 (hex) of the raw token, keyed by SWARM_SESSION_SECRET. */
    tokenHash: string;
    /** Unix milliseconds after which the token is dead. */
    expiresAt: number;
  };
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
 * Serializes read-modify-write cycles on users.json — within this process
 * (the promise tail, same shape as the AsyncLock in
 * lib/runtime/session-store.ts) and across processes (the advisory
 * lockfile in lib/file-lock.ts). Two concurrent signups must not both load
 * the same snapshot and have the second write drop the first account —
 * whether the two writers are two requests in this process or two app
 * processes sharing one data directory (FIX-45; decision recorded in
 * DEPLOY.md, "User store concurrency").
 *
 * The file lock is taken inside the in-process lock, so this process
 * contends for the lockfile with at most one waiter. After the file lock
 * is acquired the read cache is dropped: another process may have written
 * while we waited, and the critical section must re-read from disk rather
 * than trust a stat that could coincide with the pre-wait snapshot.
 *
 * Not re-entrant: no call site nests acquire() (the sections only call
 * loadUsers/saveUsers). A file lock that cannot be acquired within its
 * timeout throws FileLockTimeoutError to the caller — the sections are
 * milliseconds long, so that means a wedged holder, and failing the
 * request beats silently clobbering another process's write.
 */
class UsersLock {
  private tail: Promise<void> = Promise.resolve();
  async acquire<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = this.tail;
    let resolve!: () => void;
    this.tail = new Promise<void>((res) => {
      resolve = res;
    });
    await release;
    let releaseFile: (() => void) | null = null;
    try {
      releaseFile = await acquireFileLock(`${USER_FILE}.lock`);
      usersCache = null;
      return await fn();
    } finally {
      releaseFile?.();
      resolve();
    }
  }
}

const usersLock = new UsersLock();

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
    // into the in-memory store. New accounts start unverified (FIX-44): the
    // signup route emails a verification link, and in server mode the
    // account cannot start runs until the link is clicked.
    const next = [...users, { email: normalized, password: hashed, createdAt: Date.now(), verified: false }];
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

/* ------------------------------------------------------------------ */
/* Password reset tokens + password changes (FIX-39, FIX-40 plumbing) */
/* ------------------------------------------------------------------ */

/** Reset-token wire prefix, versioned like the rt1 run tokens. */
export const PASSWORD_RESET_TOKEN_PREFIX = "pr1";

/** Random bytes in a reset token (256 bits — unguessable, unbruteforceable). */
const RESET_TOKEN_BYTES = 32;

/** Default reset-link lifetime: 30 minutes. */
const DEFAULT_RESET_TTL_MS = 30 * 60 * 1000;

/** Reset-link lifetime in ms, from SWARM_PASSWORD_RESET_TTL_MIN (default 30). */
export function passwordResetTtlMs(): number {
  const minutes = positiveInt("SWARM_PASSWORD_RESET_TTL_MIN", 0);
  return minutes > 0 ? minutes * 60 * 1000 : DEFAULT_RESET_TTL_MS;
}

/**
 * HMAC key for reset tokens: the same SWARM_SESSION_SECRET that signs
 * session cookies and run tokens. Throws when unset — a reset token keyed
 * by an empty secret would be forgeable by anyone who can read this file.
 * Server mode already refuses to boot without the secret, so this only
 * fires for callers outside the startup guards.
 */
function resetTokenSecret(): string {
  const secret = process.env.SWARM_SESSION_SECRET ?? "";
  if (!secret.trim()) {
    throw new Error("SWARM_SESSION_SECRET is not set: refusing to mint a password-reset token with an empty key");
  }
  return secret;
}

/** What is stored at rest for a token: its keyed hash, never the token. */
function hashResetToken(token: string): string {
  return createHmac("sha256", resetTokenSecret()).update(`password-reset:${token}`).digest("hex");
}

/** base64url without padding (safe in URLs), same encoding as run tokens. */
function b64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface IssueResetTokenOptions {
  /** Injectable clock (Unix ms). Defaults to Date.now(). */
  now?: number;
  /** Token lifetime in ms. Defaults to passwordResetTtlMs(). */
  ttlMs?: number;
}

/**
 * Mint a single-use password-reset token for `email` and store only its
 * HMAC + expiry on the account. Returns the raw token (the only copy —
 * it goes into the reset email and is never persisted), or null when no
 * account exists for the email. Issuing a token invalidates any earlier
 * one for the account. Throws when SWARM_SESSION_SECRET is unset (see
 * resetTokenSecret) or the store cannot be written.
 */
export async function issuePasswordResetToken(
  email: unknown,
  options: IssueResetTokenOptions = {},
): Promise<string | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const now = options.now ?? Date.now();
  const token = `${PASSWORD_RESET_TOKEN_PREFIX}.${b64url(randomBytes(RESET_TOKEN_BYTES))}`;
  const tokenHash = hashResetToken(token);
  const expiresAt = now + (options.ttlMs ?? passwordResetTtlMs());
  const stored = await usersLock.acquire((): boolean => {
    const users = loadUsers();
    const idx = users.findIndex((u) => u.email === normalized);
    if (idx < 0) return false;
    const next = users.map((u, i) => (i === idx ? { ...u, passwordReset: { tokenHash, expiresAt } } : u));
    saveUsers(next);
    return true;
  });
  return stored ? token : null;
}

export interface ConsumeResetTokenOptions {
  /** Injectable clock (Unix ms). Defaults to Date.now(). */
  now?: number;
}

/**
 * Consume a password-reset token: returns the account's email when the
 * token is genuine, unexpired and unused; null otherwise (unknown,
 * expired and already-used tokens are indistinguishable to the caller).
 * A successful consume — and an expired token — clears the stored hash,
 * so the token can never be replayed. The lookup scans the store for a
 * matching HMAC; the hashes are keyed digests of a 256-bit random token,
 * so comparing them leaks nothing usable.
 */
export async function consumePasswordResetToken(
  token: unknown,
  options: ConsumeResetTokenOptions = {},
): Promise<string | null> {
  if (typeof token !== "string" || !token.startsWith(`${PASSWORD_RESET_TOKEN_PREFIX}.`)) return null;
  let tokenHash: string;
  try {
    tokenHash = hashResetToken(token);
  } catch {
    // No secret: nothing can verify. Fail closed, never throw to the route.
    return null;
  }
  const now = options.now ?? Date.now();
  return usersLock.acquire((): string | null => {
    const users = loadUsers();
    const idx = users.findIndex((u) => u.passwordReset?.tokenHash === tokenHash);
    if (idx < 0) return null;
    const pending = users[idx].passwordReset;
    // Clear on every terminal outcome (used or expired): single-use.
    const next = users.map((u, i) => {
      if (i !== idx) return u;
      const copy = { ...u };
      delete copy.passwordReset;
      return copy;
    });
    try {
      saveUsers(next);
    } catch {
      return null;
    }
    if (!pending || pending.expiresAt <= now) return null;
    return users[idx].email;
  });
}

export type SetUserPasswordError = "invalid" | "unknown" | "busy" | "fatal";

export type SetUserPasswordResult = { ok: true } | { ok: false; error: SetUserPasswordError };

/**
 * Set a local account's password (shared plumbing for the FIX-39 reset
 * confirm and the FIX-40 signed-in change-password). The new password is
 * scrypt-hashed with the same parameters as signup, any pending reset
 * token is cleared, and the session epoch is raised to now in the same
 * write — every existing session dies with the old password. Hashing
 * runs outside the lock (same reasoning as signupLocalUser); the write
 * re-reads inside it.
 */
export async function setUserPassword(email: unknown, newPassword: unknown): Promise<SetUserPasswordResult> {
  const normalized = normalizeEmail(email);
  if (
    !normalized ||
    typeof newPassword !== "string" ||
    newPassword.length < MIN_PASSWORD_LEN ||
    newPassword.length > MAX_PASSWORD_LEN
  ) {
    return { ok: false, error: "invalid" };
  }
  if (!loadUsers().some((u) => u.email === normalized)) {
    return { ok: false, error: "unknown" };
  }
  let hashed: string;
  try {
    hashed = await hashPassword(newPassword);
  } catch (err) {
    if (isScryptBusyError(err)) return { ok: false, error: "busy" };
    throw err;
  }
  return usersLock.acquire((): SetUserPasswordResult => {
    const users = loadUsers();
    const idx = users.findIndex((u) => u.email === normalized);
    if (idx < 0) return { ok: false, error: "unknown" };
    const now = Date.now();
    const next = users.map((u, i) => {
      if (i !== idx) return u;
      const copy = { ...u, password: hashed, sessionEpoch: now };
      delete copy.passwordReset;
      return copy;
    });
    try {
      saveUsers(next);
      return { ok: true };
    } catch {
      return { ok: false, error: "fatal" };
    }
  });
}

export type ChangePasswordError = "invalid" | "wrong-current" | "unknown" | "busy" | "fatal";
export type ChangePasswordResult = { ok: true } | { ok: false; error: ChangePasswordError };

/**
 * Change a local account's password after verifying the current one
 * (FIX-40, the signed-in counterpart to the FIX-39 reset flow). The
 * current-password check is timing-equalized the same way verifyLocalUser
 * is: an unknown account burns one scrypt derivation against the fixed
 * dummy hash, so "no such account" and "wrong current password" cost the
 * same before responding. The new password must meet the same policy as
 * signup (8–1024 chars).
 *
 * On success the shared setUserPassword primitive replaces the hash and
 * raises the session epoch in one write, revoking every existing
 * session; the caller re-mints the current device's cookie with an
 * issued-at after getSessionEpoch(email) so the person changing their
 * password stays signed in here.
 */
export async function changeLocalPassword(
  email: unknown,
  currentPassword: unknown,
  newPassword: unknown,
): Promise<ChangePasswordResult> {
  const normalized = normalizeEmail(email);
  if (
    !normalized ||
    typeof currentPassword !== "string" ||
    !currentPassword ||
    typeof newPassword !== "string" ||
    newPassword.length < MIN_PASSWORD_LEN ||
    newPassword.length > MAX_PASSWORD_LEN
  ) {
    return { ok: false, error: "invalid" };
  }
  const user = loadUsers().find((u) => u.email === normalized);
  if (!user) {
    await verifyPassword(currentPassword, DUMMY_SCRYPT_HASH);
    return { ok: false, error: "unknown" };
  }
  let currentOk: boolean;
  try {
    currentOk = await verifyPassword(currentPassword, user.password);
  } catch (err) {
    if (isScryptBusyError(err)) return { ok: false, error: "busy" };
    throw err;
  }
  if (!currentOk) return { ok: false, error: "wrong-current" };
  return setUserPassword(normalized, newPassword);
}


/* ------------------------------------------------------------------ */
/* Email verification (FIX-44)                                         */
/* ------------------------------------------------------------------ */

/** Verification-token wire prefix, versioned like the pr1 reset tokens. */
export const EMAIL_VERIFICATION_TOKEN_PREFIX = "ev1";

/** Random bytes in a verification token (256 bits — unguessable). */
const VERIFY_TOKEN_BYTES = 32;

/** Default verification-link lifetime: 24 hours (inbox latency is real). */
const DEFAULT_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Verification-link lifetime in ms, from SWARM_EMAIL_VERIFY_TTL_HOURS (default 24). */
export function emailVerificationTtlMs(): number {
  const hours = positiveInt("SWARM_EMAIL_VERIFY_TTL_HOURS", 0);
  return hours > 0 ? hours * 60 * 60 * 1000 : DEFAULT_VERIFY_TTL_MS;
}

/**
 * What is stored at rest for a verification token: its keyed hash, never
 * the token. The HMAC domain ("email-verify:") differs from the reset
 * domain ("password-reset:"), so the two token kinds can never be
 * substituted for each other even though they share the secret.
 */
function hashVerificationToken(token: string): string {
  return createHmac("sha256", resetTokenSecret()).update(`email-verify:${token}`).digest("hex");
}

export interface IssueVerificationTokenOptions {
  /** Injectable clock (Unix ms). Defaults to Date.now(). */
  now?: number;
  /** Token lifetime in ms. Defaults to emailVerificationTtlMs(). */
  ttlMs?: number;
}

/**
 * Mint a single-use email-verification token for `email` and store only
 * its HMAC + expiry on the account. Returns the raw token (the only copy
 * — it goes into the verification email and is never persisted), or null
 * when no account exists for the email or the account is already
 * verified (nothing to verify). Issuing a token invalidates any earlier
 * one. Throws when SWARM_SESSION_SECRET is unset (see resetTokenSecret)
 * or the store cannot be written.
 */
export async function issueEmailVerificationToken(
  email: unknown,
  options: IssueVerificationTokenOptions = {},
): Promise<string | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const now = options.now ?? Date.now();
  const token = `${EMAIL_VERIFICATION_TOKEN_PREFIX}.${b64url(randomBytes(VERIFY_TOKEN_BYTES))}`;
  const tokenHash = hashVerificationToken(token);
  const expiresAt = now + (options.ttlMs ?? emailVerificationTtlMs());
  const stored = await usersLock.acquire((): boolean => {
    const users = loadUsers();
    const idx = users.findIndex((u) => u.email === normalized);
    if (idx < 0) return false;
    if (users[idx].verified !== false) return false; // already verified (or grandfathered)
    const next = users.map((u, i) => (i === idx ? { ...u, emailVerification: { tokenHash, expiresAt } } : u));
    saveUsers(next);
    return true;
  });
  return stored ? token : null;
}

export interface ConsumeVerificationTokenOptions {
  /** Injectable clock (Unix ms). Defaults to Date.now(). */
  now?: number;
}

/**
 * Consume an email-verification token: on a genuine, unexpired, unused
 * token, marks the account verified, clears the stored hash (single-use)
 * and returns the account's email. Returns null otherwise (unknown,
 * expired and already-used tokens are indistinguishable to the caller).
 * An expired token's hash is cleared too, so it can never be replayed.
 */
export async function consumeEmailVerificationToken(
  token: unknown,
  options: ConsumeVerificationTokenOptions = {},
): Promise<string | null> {
  if (typeof token !== "string" || !token.startsWith(`${EMAIL_VERIFICATION_TOKEN_PREFIX}.`)) return null;
  let tokenHash: string;
  try {
    tokenHash = hashVerificationToken(token);
  } catch {
    // No secret: nothing can verify. Fail closed, never throw to the route.
    return null;
  }
  const now = options.now ?? Date.now();
  return usersLock.acquire((): string | null => {
    const users = loadUsers();
    const idx = users.findIndex((u) => u.emailVerification?.tokenHash === tokenHash);
    if (idx < 0) return null;
    const pending = users[idx].emailVerification;
    const valid = Boolean(pending && pending.expiresAt > now);
    // Clear on every terminal outcome (used or expired): single-use. On
    // success the account flips to verified in the same write.
    const next = users.map((u, i) => {
      if (i !== idx) return u;
      const copy = valid ? { ...u, verified: true } : { ...u };
      delete copy.emailVerification;
      return copy;
    });
    try {
      saveUsers(next);
    } catch {
      return null;
    }
    return valid ? users[idx].email : null;
  });
}

/**
 * True when the local account for `email` may consume VM compute: the
 * account exists and is verified, or predates verification (no `verified`
 * field — grandfathered). Unknown or invalid emails report false.
 */
export function isEmailVerified(email: unknown): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const user = loadUsers().find((u) => u.email === normalized);
  if (!user) return false;
  return user.verified !== false;
}

/**
 * Run-start gate predicate (FIX-44): true when `userId` is allowed to
 * start runs. Only local password accounts carry a verification flag —
 * any other user id (harness, paired computer, legacy shapes) is not a
 * local account and passes. A local account passes when verified or
 * grandfathered (see isEmailVerified); an unknown local id fails closed.
 */
export function isEmailVerifiedForUserId(userId: string): boolean {
  if (!userId.startsWith("local_") || !userId.includes("@")) return true;
  return isEmailVerified(emailForUserId(userId));
}
