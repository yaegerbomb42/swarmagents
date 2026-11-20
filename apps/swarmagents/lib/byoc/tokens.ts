/**
 * Pairing codes and per-device tokens for bring-your-own-compute nodes.
 *
 * Flow:
 *   1. The human asks the app for a pairing code (POST /api/byoc/pair). The
 *      code is short, single use and expires after BYOC_PAIRING_TTL_MS.
 *   2. `swarm-node --pair <code>` redeems it over the WebSocket. The server
 *      answers with a per-device token; the node stores it locally and the
 *      server keeps only its SHA-256 hash.
 *   3. Every later connection presents that token. Revoking the device
 *      (DELETE /api/byoc/nodes/<id>) marks the record revoked and kills the
 *      live session — the token stops working immediately.
 *
 * Tokens and codes are never logged, never returned by the list API and
 * never stored in clear.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStorageDir, isDirWritable } from "../board/store";
import { BYOC_PAIRING_TTL_MS } from "../../packages/swarm-node/src/protocol";

/** A paired node, as the server knows it. */
export interface ByocDeviceRecord {
  /** Server-side id of the device ("dev_…"). */
  id: string;
  /** The account the device belongs to. */
  userId: string;
  /** Human-readable node name. */
  name: string;
  /** SHA-256 (hex) of the device token. The token itself is never stored. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

/** A pending one-time pairing code. */
export interface ByocPairingRecord {
  /** SHA-256 (hex) of the code. The code itself is never stored. */
  codeHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

interface ByocStoreFile {
  version: 1;
  devices: ByocDeviceRecord[];
  codes: ByocPairingRecord[];
}

/** Ambiguous characters (0/O, 1/I) are left out of the code alphabet. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 2;
const CODE_GROUP_LEN = 4;

/** SHA-256 hex digest. */
export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Normalize a code the human typed: upper case, dashes and spaces removed. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Render a code as "XXXX-XXXX" for the human. */
export function formatPairingCode(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < CODE_GROUPS; i++) {
    groups.push(code.slice(i * CODE_GROUP_LEN, (i + 1) * CODE_GROUP_LEN));
  }
  return groups.join("-");
}

/** Generate a fresh random code (unformatted, no dash). */
function generateCode(): string {
  const bytes = crypto.randomBytes(CODE_GROUPS * CODE_GROUP_LEN);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Generate a per-device token (base64url, 32 bytes of entropy). */
export function generateDeviceToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Where the BYOC store lives (next to the board in the data dir). */
export function resolveByocFile(): string {
  const home = process.env.SWARM_HOME;
  if (home && isDirWritable(home)) return path.join(home, "byoc.json");
  return path.join(resolveStorageDir(), "byoc.json");
}

/** Why a pairing attempt failed. */
export type ByocPairError = "invalid" | "expired" | "used";

/** Result of redeeming a pairing code. */
export type ByocPairResult =
  | { ok: true; token: string; device: ByocDeviceRecord }
  | { ok: false; error: ByocPairError };

/** Result of verifying a device token. */
export type ByocTokenResult =
  | { ok: true; device: ByocDeviceRecord }
  | { ok: false; error: "invalid" | "revoked" };

export interface ByocTokenStoreOptions {
  /** Override the store file (tests). */
  file?: string;
  /** Injectable clock. */
  now?: () => number;
  /** Pairing code lifetime. */
  pairingTtlMs?: number;
}

/**
 * Persistent store of pairing codes and paired devices.
 *
 * Everything is scoped by `userId`: a code belongs to the account that
 * created it and can only pair a device for that account.
 */
export class ByocTokenStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly pairingTtlMs: number;
  private state: ByocStoreFile = { version: 1, devices: [], codes: [] };
  private loaded = false;

  constructor(opts: ByocTokenStoreOptions = {}) {
    this.file = opts.file ?? resolveByocFile();
    this.now = opts.now ?? Date.now;
    this.pairingTtlMs = opts.pairingTtlMs ?? BYOC_PAIRING_TTL_MS;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as ByocStoreFile;
      this.state = {
        version: 1,
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        codes: Array.isArray(parsed.codes) ? parsed.codes : [],
      };
    } catch {
      // Missing or corrupt file: start empty rather than crash the app.
      this.state = { version: 1, devices: [], codes: [] };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Create a one-time pairing code for a user. Returns the clear code. */
  createPairingCode(userId: string, ttlMs?: number): { code: string; expiresAt: number } {
    this.load();
    const now = this.now();
    const ttl = ttlMs ?? this.pairingTtlMs;
    const code = generateCode();
    // Drop expired codes so the file does not grow without bound.
    this.state.codes = this.state.codes.filter((c) => c.expiresAt > now && !c.usedAt);
    this.state.codes.push({
      codeHash: hashSecret(code),
      userId,
      createdAt: now,
      expiresAt: now + ttl,
    });
    this.save();
    return { code: formatPairingCode(code), expiresAt: now + ttl };
  }

  /**
   * Redeem a pairing code and mint a device token. The code is single use:
   * a second attempt fails even with the same code.
   */
  redeemPairingCode(code: string, deviceName: string): ByocPairResult {
    this.load();
    const now = this.now();
    const normalized = normalizePairingCode(code);
    if (!normalized) return { ok: false, error: "invalid" };

    const hash = hashSecret(normalized);
    const record = this.state.codes.find((c) => safeEqualHex(c.codeHash, hash));
    if (!record) return { ok: false, error: "invalid" };
    if (record.usedAt) return { ok: false, error: "used" };
    if (record.expiresAt <= now) return { ok: false, error: "expired" };

    record.usedAt = now;
    const token = generateDeviceToken();
    const device: ByocDeviceRecord = {
      id: `dev_${crypto.randomBytes(9).toString("base64url")}`,
      userId: record.userId,
      name: deviceName.slice(0, 64) || "swarm-node",
      tokenHash: hashSecret(token),
      createdAt: now,
    };
    this.state.devices.push(device);
    this.save();
    return { ok: true, token, device };
  }

  /** Verify a device token. Revoked devices are reported as "revoked". */
  verifyToken(token: string): ByocTokenResult {
    this.load();
    if (!token) return { ok: false, error: "invalid" };
    const hash = hashSecret(token);
    const device = this.state.devices.find((d) => safeEqualHex(d.tokenHash, hash));
    if (!device) return { ok: false, error: "invalid" };
    if (device.revokedAt) return { ok: false, error: "revoked" };
    return { ok: true, device };
  }

  /** Record that a device just connected. */
  touch(deviceId: string): void {
    this.load();
    const device = this.state.devices.find((d) => d.id === deviceId);
    if (!device) return;
    device.lastSeenAt = this.now();
    this.save();
  }

  /** All devices of one user (newest first). Never exposes a token. */
  listDevices(userId: string): ByocDeviceRecord[] {
    this.load();
    return this.state.devices
      .filter((d) => d.userId === userId)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** One device of one user (never crosses accounts). */
  getDevice(userId: string, deviceId: string): ByocDeviceRecord | null {
    this.load();
    return this.state.devices.find((d) => d.id === deviceId && d.userId === userId) ?? null;
  }

  /**
   * Revoke a device. The token stops working immediately; the hub also kills
   * the live session for it. Returns false when the device does not belong
   * to the user.
   */
  revokeDevice(userId: string, deviceId: string, reason = "revoked by user"): boolean {
    this.load();
    const device = this.state.devices.find((d) => d.id === deviceId && d.userId === userId);
    if (!device) return false;
    if (!device.revokedAt) {
      device.revokedAt = this.now();
      device.revokedReason = reason;
    }
    this.save();
    return true;
  }

  /** Forget codes that expired (housekeeping). */
  pruneExpiredCodes(): void {
    this.load();
    const now = this.now();
    const before = this.state.codes.length;
    this.state.codes = this.state.codes.filter((c) => !c.usedAt && c.expiresAt > now);
    if (this.state.codes.length !== before) this.save();
  }
}

/** Process-wide store used by the hub and the API routes. */
const g = globalThis as typeof globalThis & { __swarmByocTokens?: ByocTokenStore };

export function getByocTokenStore(): ByocTokenStore {
  if (!g.__swarmByocTokens) g.__swarmByocTokens = new ByocTokenStore();
  return g.__swarmByocTokens;
}

/** Test hook: swap (or clear) the process-wide store. */
export function setByocTokenStoreForTesting(store: ByocTokenStore | null): void {
  g.__swarmByocTokens = store ?? undefined;
}
