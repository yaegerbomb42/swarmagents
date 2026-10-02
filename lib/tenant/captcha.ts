// Sign-up captcha (deploy lane, Jimmy 23:14): ALTCHA, a self-hosted proof-of-work challenge. No third party, no key
// to register. The server issues an HMAC-signed challenge (GET /api/signup), the browser solves it (PBKDF2 PoW, about
// a second), and POST /api/signup verifies the solution here before anything else happens. Each challenge expires
// after 10 minutes and is accepted once (its nonce is recorded until it expires).
//
// The HMAC key is a root-only secret file: SWARM_ALTCHA_KEY_FILE when set, otherwise $SWARM_HOME/altcha-hmac.key,
// generated on first use (0600, next to auth.db, which the sandbox can't read). It is never in the source tree.
// SWARM_SIGNUP_CAPTCHA=off disables the check (test containers only).

import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createChallenge, randomInt } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { verify } from "altcha-lib/frameworks/shared";

const HOME = process.env.SWARM_HOME || path.join(process.env.HOME ?? "/tmp", ".swarmagents");
const TTL_S = 10 * 60;

export const captchaEnabled = () => process.env.SWARM_SIGNUP_CAPTCHA !== "off";

const g = globalThis as unknown as { __swarmAltcha?: { key: string; keyKey: string; db: DatabaseSync | null } };

function state() {
  if (g.__swarmAltcha) return g.__swarmAltcha;
  const file = process.env.SWARM_ALTCHA_KEY_FILE || path.join(HOME, "altcha-hmac.key");
  let key = "";
  try {
    key = fs.readFileSync(file, "utf8").trim();
  } catch {}
  if (key.length < 32) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    key = randomBytes(32).toString("hex");
    // O_EXCL: if another worker won the race, use its key.
    try {
      fs.writeFileSync(file, key + "\n", { mode: 0o600, flag: "wx" });
    } catch {
      key = fs.readFileSync(file, "utf8").trim();
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  // A second, derived secret signs the deterministic key prefix (altcha-lib's hmacKeySignatureSecret).
  const keyKey = createHash("sha256").update(`altcha-key-signature:${key}`).digest("hex");
  let db: DatabaseSync | null = null;
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    const f = path.join(HOME, "signup-limit.db");
    db = new DatabaseSync(f);
    fs.chmodSync(f, 0o600);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS altcha_used (id TEXT PRIMARY KEY, exp INTEGER NOT NULL);
    `);
  } catch (e) {
    console.warn("[captcha] replay store unavailable, using memory:", (e as Error).message);
  }
  return (g.__swarmAltcha = { key, keyKey, db });
}

// Memory fallback for the replay store.
const usedMem = new Map<string, number>();

/** Single-use store: get() says whether the challenge was seen, set() records it until it expires. */
const store = {
  get(id: string) {
    const now = Math.floor(Date.now() / 1000);
    const { db } = state();
    if (db) {
      db.prepare("DELETE FROM altcha_used WHERE exp < ?").run(now);
      return !!db.prepare("SELECT 1 FROM altcha_used WHERE id = ?").get(id);
    }
    for (const [k, exp] of usedMem) if (exp < now) usedMem.delete(k);
    return usedMem.has(id);
  },
  set(id: string) {
    const exp = Math.floor(Date.now() / 1000) + TTL_S + 60;
    const { db } = state();
    if (db) db.prepare("INSERT OR IGNORE INTO altcha_used (id, exp) VALUES (?, ?)").run(id, exp);
    else {
      if (usedMem.size > 100_000) usedMem.clear();
      usedMem.set(id, exp);
    }
    return true;
  },
};

/** A fresh signed challenge for the widget. Cost is tuned for roughly 0.5 to 2 s in a browser. */
export async function signupChallenge() {
  const { key, keyKey } = state();
  return createChallenge({
    algorithm: "PBKDF2/SHA-256",
    cost: Number(process.env.SWARM_ALTCHA_COST) || 1_000,
    counter: randomInt(Number(process.env.SWARM_ALTCHA_MAX_COUNTER) || 3_000, 1_000),
    deriveKey,
    expiresAt: Math.floor(Date.now() / 1000) + TTL_S,
    hmacSignatureSecret: key,
    hmacKeySignatureSecret: keyKey,
  });
}

/** null when the payload (the widget's base64 "altcha" value) is a valid, unexpired, unused solution. */
export async function signupCaptchaError(payload: unknown): Promise<string | null> {
  if (!captchaEnabled()) return null;
  if (typeof payload !== "string" || !payload || payload.length > 8_000) return "Please complete the human check.";
  const { key, keyKey } = state();
  const r = await verify(payload, deriveKey, key, keyKey, store);
  if (r.error || !r.verification?.verified) {
    if (/already used/i.test(r.error ?? "")) return "That human check was already used. Please run it again.";
    if ((r.verification as { expired?: boolean } | null)?.expired) return "The human check expired. Please run it again.";
    return "The human check failed. Please run it again.";
  }
  return null;
}
