/**
 * Shareable preview tokens (F10).
 *
 * Mirrors the project share-link pattern (lib/projects/store): a random
 * 48-hex-char token is the only credential for a public preview URL
 * (`/preview/share/<token>/<port>/`). The token is bound to one owner and
 * one port; resolving it never reads another account's file.
 *
 * Layout (same data dir as the project store):
 *   `<data>/users/<hash(userId)>/preview-tokens.json` — the owner's tokens
 *   (one per port; creating a share for a port rotates its token).
 *   `<data>/preview-shares/<token>.json` — the global index entry the
 *   token-only lookup reads: { token, ownerId, port, createdAt }.
 * Files are written via temp file + rename, dir 700 / file 600, exactly
 * like the project store. A revoked token's index entry is deleted
 * immediately, so the old link 404s. The index never holds credentials —
 * only the owner id, the port, and timestamps.
 *
 * Bounds: at most one live token per port, at most 16 tokens per user.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, userDirName, type DataDirOptions } from "../providers/store";

export const PREVIEW_SHARE_TOKEN_BYTES = 24;
export const PREVIEW_SHARE_TOKEN_RE = /^[a-f0-9]{48}$/;
export const PREVIEW_SHARE_INDEX_SCHEMA = "swarm-preview-share-index";
export const PREVIEW_SHARE_INDEX_VERSION = 1;
export const PREVIEW_SHARE_FILE_VERSION = 1;
/** Directory (under the data dir) holding one index file per preview token. */
export const PREVIEW_SHARE_INDEX_DIR = "preview-shares";
export const MAX_PREVIEW_SHARES_PER_USER = 16;

export interface PreviewShare {
  /** 48-hex-char token; the only credential for the public preview URL. */
  token: string;
  /** In-VM port this token exposes. */
  port: number;
  /** Epoch ms when the token was created (or last rotated). */
  createdAt: number;
  /** Epoch ms when the token was revoked, if ever. */
  revokedAt?: number;
}

export interface PreviewShareOwner {
  ownerId: string;
  port: number;
  createdAt: number;
}

interface PreviewShareIndexEntry {
  schema: typeof PREVIEW_SHARE_INDEX_SCHEMA;
  version: typeof PREVIEW_SHARE_INDEX_VERSION;
  token: string;
  ownerId: string;
  port: number;
  createdAt: number;
}

interface PreviewTokensFile {
  version: typeof PREVIEW_SHARE_FILE_VERSION;
  userId: string;
  shares: PreviewShare[];
}

let OVERRIDE_DIR: string | undefined;

/** Test hook: point the store at a directory ("" resets to the data dir). */
export function configurePreviewShareDir(dir: string): void {
  OVERRIDE_DIR = dir || undefined;
}

function dataDir(options: DataDirOptions = {}): string {
  return OVERRIDE_DIR ?? resolveDataDir(options);
}

function userTokensFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(dataDir(options), "users", userDirName(userId), "preview-tokens.json");
}

function indexDir(options: DataDirOptions = {}): string {
  return path.join(dataDir(options), PREVIEW_SHARE_INDEX_DIR);
}

function indexEntryPath(token: string, options: DataDirOptions = {}): string {
  return path.join(indexDir(options), `${token}.json`);
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function cleanShare(value: unknown): PreviewShare | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.token !== "string" || !PREVIEW_SHARE_TOKEN_RE.test(entry.token)) return null;
  if (!validPort(entry.port)) return null;
  if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) return null;
  const share: PreviewShare = {
    token: entry.token,
    port: entry.port,
    createdAt: entry.createdAt,
  };
  if (typeof entry.revokedAt === "number" && Number.isFinite(entry.revokedAt)) {
    share.revokedAt = entry.revokedAt;
  }
  return share;
}

function readFileFor(userId: string, options: DataDirOptions = {}): PreviewTokensFile {
  const empty: PreviewTokensFile = { version: PREVIEW_SHARE_FILE_VERSION, userId, shares: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(userTokensFilePath(userId, options), "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return empty;
    const shares = Array.isArray((parsed as PreviewTokensFile).shares)
      ? (parsed as PreviewTokensFile).shares
          .map((entry) => cleanShare(entry))
          .filter((entry): entry is PreviewShare => entry !== null)
      : [];
    return { version: PREVIEW_SHARE_FILE_VERSION, userId, shares };
  } catch {
    return empty;
  }
}

function writeFileFor(userId: string, data: PreviewTokensFile, options: DataDirOptions = {}): void {
  const file = userTokensFilePath(userId, options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* Best effort on read-only or foreign-owned mounts. */
  }
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Best effort. */
  }
}

function cleanIndexEntry(value: unknown, token: string): PreviewShareIndexEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (entry.schema !== PREVIEW_SHARE_INDEX_SCHEMA) return null;
  if (entry.version !== PREVIEW_SHARE_INDEX_VERSION) return null;
  if (entry.token !== token) return null;
  if (typeof entry.ownerId !== "string" || entry.ownerId.length === 0 || entry.ownerId.length > 256) return null;
  if (!validPort(entry.port)) return null;
  if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) return null;
  return {
    schema: PREVIEW_SHARE_INDEX_SCHEMA,
    version: PREVIEW_SHARE_INDEX_VERSION,
    token,
    ownerId: entry.ownerId,
    port: entry.port,
    createdAt: entry.createdAt,
  };
}

function writeIndexEntry(entry: PreviewShareIndexEntry, options: DataDirOptions = {}): void {
  const dir = indexDir(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = indexEntryPath(entry.token, options);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Best effort. */
  }
}

function removeIndexEntry(token: string, options: DataDirOptions = {}): void {
  try {
    fs.rmSync(indexEntryPath(token, options), { force: true });
  } catch {
    /* A missing entry is already revoked. */
  }
}

/** Live (unrevoked) shares for the owner, newest first. */
export function listPreviewShares(userId: string, options: DataDirOptions = {}): PreviewShare[] {
  return readFileFor(userId, options).shares.filter((share) => share.revokedAt === undefined);
}

/**
 * Create (or rotate) a share token for `port`. One live token per port:
 * rotating replaces the old token and its index entry, so the old link 404s.
 */
export function createPreviewShare(userId: string, port: number, options: DataDirOptions = {}): PreviewShare {
  if (!validPort(port)) throw new Error("Invalid preview port.");
  const previous = readFileFor(userId, options).shares.find(
    (share) => share.port === port && share.revokedAt === undefined,
  );
  const token = randomBytes(PREVIEW_SHARE_TOKEN_BYTES).toString("hex");
  const share: PreviewShare = { token, port, createdAt: Date.now() };
  const data = readFileFor(userId, options);
  data.shares = data.shares.filter((entry) => entry.port !== port);
  data.shares.push(share);
  // Bound the store: a runaway caller cannot grow it without limit.
  if (data.shares.length > MAX_PREVIEW_SHARES_PER_USER) {
    data.shares.splice(0, data.shares.length - MAX_PREVIEW_SHARES_PER_USER);
  }
  writeFileFor(userId, data, options);
  if (previous && previous.token !== token) removeIndexEntry(previous.token, options);
  writeIndexEntry(
    {
      schema: PREVIEW_SHARE_INDEX_SCHEMA,
      version: PREVIEW_SHARE_INDEX_VERSION,
      token,
      ownerId: userId,
      port,
      createdAt: share.createdAt,
    },
    options,
  );
  return share;
}

/** Revoke the share for `port`; the token stops resolving immediately. */
export function revokePreviewShare(userId: string, port: number, options: DataDirOptions = {}): boolean {
  if (!validPort(port)) return false;
  const data = readFileFor(userId, options);
  const share = data.shares.find((entry) => entry.port === port && entry.revokedAt === undefined);
  if (!share) return false;
  share.revokedAt = Date.now();
  writeFileFor(userId, data, options);
  removeIndexEntry(share.token, options);
  return true;
}

/**
 * Resolve a live share token to its owner and port. The token is the only
 * credential and the only thing that is read: one index file, then the
 * owner's token file to confirm it is still live. A revoked token never
 * resolves, and a miss never reads another account's file.
 */
export function resolvePreviewShare(token: string, options: DataDirOptions = {}): PreviewShareOwner | null {
  if (!PREVIEW_SHARE_TOKEN_RE.test(token)) return null;
  let entry: PreviewShareIndexEntry | null = null;
  try {
    entry = cleanIndexEntry(JSON.parse(fs.readFileSync(indexEntryPath(token, options), "utf-8")) as unknown, token);
  } catch {
    return null;
  }
  if (!entry) return null;
  // The index entry outlived its revocation: confirm against the owner's
  // file and drop the stale entry if it no longer matches.
  const live = readFileFor(entry.ownerId, options).shares.find(
    (share) => share.token === token && share.port === entry.port && share.revokedAt === undefined,
  );
  if (!live) {
    removeIndexEntry(token, options);
    return null;
  }
  return { ownerId: entry.ownerId, port: entry.port, createdAt: entry.createdAt };
}
