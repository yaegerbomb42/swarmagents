/**
 * Encryption at rest for per-user provider API keys.
 *
 * Keys are sealed with AES-256-GCM. The data key is derived with HKDF-SHA256
 * from, in order of preference:
 *
 *   1. SWARM_KEYS_SECRET            (key id "k": the intended production setup)
 *   2. SWARM_SESSION_SECRET         (key id "s": fallback, logs a warning)
 *   3. a random key file in the data dir, mode 600 (key id "f": local/dev only)
 *
 * Every ciphertext records which key sealed it, so adding SWARM_KEYS_SECRET
 * later does not strand keys sealed under the fallback: they still decrypt
 * (as long as the old secret is present) and are re-sealed under the new key
 * on the next write.
 *
 * The additional authenticated data binds a ciphertext to its owner and
 * provider, so a sealed key copied into another user's file (or another
 * provider entry) fails to decrypt instead of being usable there.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FORMAT = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const HKDF_SALT = "swarmagents/provider-keys/v1";
const KEY_FILE_NAME = ".provider-keys.secret";

export type KeyId = "k" | "s" | "f";

/** A sealed value could not be opened (wrong secret, tampering, wrong owner). */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

interface SecretBoxOptions {
  env?: Record<string, string | undefined>;
  /** Directory for the last-resort key file (key id "f"). */
  dataDir?: string;
}

let warnedSessionFallback = false;
let warnedFileFallback = false;

function derive(ikm: string | Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, HKDF_SALT, info, KEY_BYTES));
}

function nonEmpty(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v ? v : null;
}

function keyFilePath(dataDir: string): string {
  return path.join(dataDir, KEY_FILE_NAME);
}

function readKeyFile(dataDir: string | undefined): Buffer | null {
  if (!dataDir) return null;
  try {
    const raw = fs.readFileSync(keyFilePath(dataDir), "utf-8").trim();
    const buf = Buffer.from(raw, "base64");
    return buf.length === KEY_BYTES ? buf : null;
  } catch {
    return null;
  }
}

function createKeyFile(dataDir: string): Buffer {
  const existing = readKeyFile(dataDir);
  if (existing) return existing;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const file = keyFilePath(dataDir);
  try {
    // "wx": never clobber a key file another process just created.
    fs.writeFileSync(file, key.toString("base64") + "\n", { encoding: "utf-8", mode: 0o600, flag: "wx" });
  } catch {
    const raced = readKeyFile(dataDir);
    if (raced) return raced;
    throw new SecretBoxError(`Could not create the provider key file ${file}.`);
  }
  return key;
}

/** The data key for a key id, or null when its secret is not available. */
function keyFor(kid: KeyId, options: SecretBoxOptions): Buffer | null {
  const env = options.env ?? process.env;
  switch (kid) {
    case "k": {
      const secret = nonEmpty(env.SWARM_KEYS_SECRET);
      return secret ? derive(secret, "aes-256-gcm:keys-secret") : null;
    }
    case "s": {
      const secret = nonEmpty(env.SWARM_SESSION_SECRET);
      return secret ? derive(secret, "aes-256-gcm:session-secret-fallback") : null;
    }
    case "f": {
      const raw = readKeyFile(options.dataDir);
      return raw ? derive(raw, "aes-256-gcm:key-file") : null;
    }
  }
}

/** Which key new ciphertexts are sealed with, given the environment. */
export function activeKeyId(options: SecretBoxOptions = {}): KeyId {
  const env = options.env ?? process.env;
  if (nonEmpty(env.SWARM_KEYS_SECRET)) return "k";
  if (nonEmpty(env.SWARM_SESSION_SECRET)) {
    if (!warnedSessionFallback) {
      warnedSessionFallback = true;
      console.warn(
        "[swarm-providers] SWARM_KEYS_SECRET is not set; provider keys are encrypted with a key derived " +
          "from SWARM_SESSION_SECRET. Set SWARM_KEYS_SECRET (32+ random bytes) so rotating the session " +
          "secret never strands stored keys."
      );
    }
    return "s";
  }
  if (!options.dataDir) {
    throw new SecretBoxError("No SWARM_KEYS_SECRET, SWARM_SESSION_SECRET or data dir to derive a key from.");
  }
  if (!warnedFileFallback) {
    warnedFileFallback = true;
    console.warn(
      `[swarm-providers] SWARM_KEYS_SECRET and SWARM_SESSION_SECRET are not set; provider keys are ` +
        `encrypted with a generated key in ${keyFilePath(options.dataDir)} (local/dev only).`
    );
  }
  createKeyFile(options.dataDir);
  return "f";
}

function aad(owner: string, purpose: string): Buffer {
  return Buffer.from(`swarm-provider-key\u0000${owner}\u0000${purpose}`, "utf-8");
}

/**
 * Seal `plaintext` for `owner` (a user id) and `purpose` (the provider id).
 * Format: `v1.<kid>.<iv>.<ciphertext>.<tag>` (base64url parts).
 */
export function seal(plaintext: string, owner: string, purpose: string, options: SecretBoxOptions = {}): string {
  const kid = activeKeyId(options);
  const key = keyFor(kid, options);
  if (!key) throw new SecretBoxError("The provider encryption key is not available.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(owner, purpose));
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, kid, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

/** True when `value` looks like a sealed value (not a plaintext key). */
export function isSealed(value: string): boolean {
  return /^v1\.[ksf]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/.test(value);
}

/** Open a sealed value. Throws SecretBoxError on any failure. */
export function open(sealed: string, owner: string, purpose: string, options: SecretBoxOptions = {}): string {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== FORMAT) throw new SecretBoxError("Not a sealed provider key.");
  const kid = parts[1] as KeyId;
  if (kid !== "k" && kid !== "s" && kid !== "f") throw new SecretBoxError("Unknown key id.");
  const key = keyFor(kid, options);
  if (!key) {
    throw new SecretBoxError(
      kid === "k"
        ? "Sealed with SWARM_KEYS_SECRET, which is not set."
        : kid === "s"
          ? "Sealed with the SWARM_SESSION_SECRET fallback, which is not set."
          : "Sealed with the local key file, which is missing."
    );
  }
  try {
    const iv = Buffer.from(parts[2], "base64url");
    const ct = Buffer.from(parts[3], "base64url");
    const tag = Buffer.from(parts[4], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("bad lengths");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(owner, purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
  } catch {
    throw new SecretBoxError("Could not decrypt a provider key (wrong secret, wrong owner or tampered).");
  }
}

/** The key id a sealed value was sealed with, or null. */
export function sealedKeyId(sealed: string): KeyId | null {
  if (!isSealed(sealed)) return null;
  return sealed.split(".")[1] as KeyId;
}

/** Test hook: re-arm the one-time fallback warnings. */
export function resetSecretBoxWarnings(): void {
  warnedSessionFallback = false;
  warnedFileFallback = false;
}
