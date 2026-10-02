// Caps on *successful* sign-ups (deploy lane, Grok Bot (deploy); announced in GROUP_CHAT 21:30). lib/auth throttled()
// only counts failures, so with SWARM_SIGNUP=open one client could otherwise mint unlimited accounts (each gets an
// OS uid, a workspace and a storage quota). Per client IP (lib/auth clientIp, proxy-hop aware) and server-wide, per
// rolling hour. Override with SWARM_SIGNUP_PER_IP_HOUR / SWARM_SIGNUP_PER_HOUR.
//
// Persisted in $SWARM_HOME/signup-limit.db (root, 0600, next to auth.db) so a redeploy or restart doesn't reset the
// window (22:20: deploys every ~10 min made the in-memory cap meaningless). Only sha256(ip) and a timestamp are
// stored, and rows older than an hour are deleted. If the file can't be opened it falls back to memory.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const HOUR = 60 * 60 * 1000;
const HOME = process.env.SWARM_HOME || path.join(process.env.HOME ?? "/tmp", ".swarmagents");

const limit = (v: string | undefined, d: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : d;
};
const ipKey = (ip: string) => createHash("sha256").update(`signup:${ip}`).digest("hex").slice(0, 32);

const g = globalThis as unknown as { __swarmSignupDb?: DatabaseSync | null };

function db(): DatabaseSync | null {
  if (g.__swarmSignupDb !== undefined) return g.__swarmSignupDb;
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    const file = path.join(HOME, "signup-limit.db");
    const d = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    d.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS signups (ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS signups_ip ON signups(ip, at);
      CREATE INDEX IF NOT EXISTS signups_at ON signups(at);
    `);
    return (g.__swarmSignupDb = d);
  } catch (e) {
    console.warn("[signup-limit] persistent store unavailable, using memory:", (e as Error).message);
    return (g.__swarmSignupDb = null);
  }
}

// Memory fallback (only when the db can't be opened).
const perIp = new Map<string, number[]>();
let all: number[] = [];
const recent = (list: number[], now: number) => list.filter((t) => now - t < HOUR);

function counts(ip: string, now: number): { mine: number; total: number } {
  const d = db();
  const k = ipKey(ip);
  if (d) {
    d.prepare("DELETE FROM signups WHERE at <= ?").run(now - HOUR);
    const mine = (d.prepare("SELECT COUNT(*) AS n FROM signups WHERE ip = ? AND at > ?").get(k, now - HOUR) as { n: number }).n;
    const total = (d.prepare("SELECT COUNT(*) AS n FROM signups WHERE at > ?").get(now - HOUR) as { n: number }).n;
    return { mine: Number(mine), total: Number(total) };
  }
  all = recent(all, now);
  const list = recent(perIp.get(k) ?? [], now);
  if (list.length) perIp.set(k, list);
  else perIp.delete(k);
  return { mine: list.length, total: all.length };
}

/** null when this client may create another account now; otherwise the message for a 429. */
export function signupBlocked(ip: string, now = Date.now()): string | null {
  const { mine, total } = counts(ip, now);
  if (mine >= limit(process.env.SWARM_SIGNUP_PER_IP_HOUR, 5)) return "Too many new accounts from your network. Try again in an hour.";
  if (total >= limit(process.env.SWARM_SIGNUP_PER_HOUR, 60)) return "Sign-ups are busy right now. Try again later.";
  return null;
}

/** Record one successful sign-up for this client. */
export function noteSignup(ip: string, now = Date.now()) {
  const d = db();
  const k = ipKey(ip);
  if (d) {
    d.prepare("INSERT INTO signups (ip, at) VALUES (?, ?)").run(k, now);
    return;
  }
  if (perIp.size > 50_000) perIp.clear();
  perIp.set(k, [...recent(perIp.get(k) ?? [], now), now]);
  all = [...recent(all, now), now];
}
