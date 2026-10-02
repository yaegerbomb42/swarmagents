// Accounts for the hosted deployment: users, login sessions and signup invites in one SQLite file
// ($SWARM_HOME/auth.db) using Node's built-in driver, so there is no native module to build.
//
// Passwords are scrypt-hashed with a per-user salt. Login session tokens are random 256-bit values; the browser
// holds the token, the database holds only its sha256, so a leaked database can't be replayed as cookies.
// Invite codes are stored the same way.

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const HOME = process.env.SWARM_HOME || path.join(process.env.HOME ?? "/tmp", ".swarmagents");
const SESSION_MS = 30 * 24 * 3600_000;
/** Sliding expiry is refreshed at most this often, so a busy session doesn't write on every request. */
const TOUCH_MS = 3600_000;
const INVITE_MS = 7 * 24 * 3600_000;
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
}

const g = globalThis as unknown as { __swarmAuthDb?: DatabaseSync };

function db(): DatabaseSync {
  if (g.__swarmAuthDb) return g.__swarmAuthDb;
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const file = path.join(HOME, "auth.db");
  const d = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pw_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_sessions_user ON login_sessions(user_id);
    CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_by TEXT,
      used_at INTEGER
    );
  `);
  return (g.__swarmAuthDb = d);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${h.toString("base64")}`;
}

function verifyPassword(pw: string, stored: string) {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(hash, "base64");
  const got = scryptSync(pw, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(got, want);
}

/** Spend the same time on unknown usernames as on wrong passwords, so login timing doesn't reveal accounts. */
const DUMMY = hashPassword(randomBytes(12).toString("hex"));

const toUser = (row: Record<string, unknown>): User => ({ id: String(row.id), username: String(row.username), isAdmin: !!row.is_admin, createdAt: Number(row.created_at) });

export function userCount(): number {
  return Number((db().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n);
}

export function validateCredentials(username: string, password: string): string | null {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return "Username must be 3–32 letters, digits, dots, dashes or underscores.";
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (password.length > 256) return "Password is too long.";
  return null;
}

export function createUser(username: string, password: string, isAdmin = false): User {
  const id = randomBytes(8).toString("hex");
  const now = Date.now();
  db().prepare("INSERT INTO users (id, username, pw_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)").run(id, username, hashPassword(password), isAdmin ? 1 : 0, now);
  return { id, username, isAdmin, createdAt: now };
}

export function usernameTaken(username: string) {
  return !!db().prepare("SELECT 1 FROM users WHERE username = ?").get(username);
}

export function authenticate(username: string, password: string): User | null {
  const row = db().prepare("SELECT * FROM users WHERE username = ? AND disabled = 0").get(username) as Record<string, unknown> | undefined;
  if (!row) {
    verifyPassword(password, DUMMY);
    return null;
  }
  return verifyPassword(password, String(row.pw_hash)) ? toUser(row) : null;
}

/** Start a login session; returns the token for the cookie. */
export function startSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const d = db();
  d.prepare("DELETE FROM login_sessions WHERE expires_at < ?").run(now);
  d.prepare("INSERT INTO login_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha(token), userId, now, now + SESSION_MS);
  return token;
}

export function endSession(token: string) {
  if (token) db().prepare("DELETE FROM login_sessions WHERE token_hash = ?").run(sha(token));
}

/** The user a session token belongs to, or null. Extends the session while it is in use. */
export function userForToken(token: string): User | null {
  if (!token || token.length > 200) return null;
  const now = Date.now();
  const row = db()
    .prepare("SELECT u.*, s.expires_at AS exp FROM login_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.disabled = 0")
    .get(sha(token)) as Record<string, unknown> | undefined;
  if (!row || Number(row.exp) < now) return null;
  if (Number(row.exp) - now < SESSION_MS - TOUCH_MS) db().prepare("UPDATE login_sessions SET expires_at = ? WHERE token_hash = ?").run(now + SESSION_MS, sha(token));
  return toUser(row);
}

export function createInvite(createdBy: string): string {
  const code = randomBytes(12).toString("base64url");
  const now = Date.now();
  db().prepare("INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha(code), createdBy, now, now + INVITE_MS);
  return code;
}

/** Atomically consume an invite for a new user. Returns false if it is unknown, used or expired. */
export function consumeInvite(code: string, userId: string): boolean {
  if (!code) return false;
  const r = db().prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?").run(userId, Date.now(), sha(code), Date.now());
  return Number(r.changes) === 1;
}

export function inviteValid(code: string): boolean {
  return !!code && !!db().prepare("SELECT 1 FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?").get(sha(code), Date.now());
}

/** Signup policy. Default invite-only: a hosted agent has a real shell, so strangers can't self-register. */
export function signupMode(): "invite" | "open" | "closed" {
  const m = process.env.SWARM_SIGNUP;
  return m === "open" || m === "closed" ? m : "invite";
}

/** Run several statements as one transaction (signup: create the user and consume the invite together). */
export function transaction<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
