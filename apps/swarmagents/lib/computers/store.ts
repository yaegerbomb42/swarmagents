/**
 * Per-account paired computers (BYOC).
 *
 * A "computer" is a machine the user paired to their account by redeeming a
 * short-lived pairing code. The node that runs on that machine keeps the
 * computer online with a heartbeat and authenticates its own calls with a
 * per-computer node token.
 *
 * Everything lives in the owner's own account directory —
 * `<data dir>/users/<hash(userId)>/computers.json` (dir mode 700, file mode
 * 600) — the same per-user layout the project/provider stores use. There is no
 * server-wide computer file. The only cross-account read is the pairing-code
 * redemption and heartbeat lookup, which scan the per-user files for an opaque
 * hash/id and return nothing but the matching account's own computer.
 *
 * The node token is never stored or returned in clear: only its SHA-256 hash
 * is persisted, and the clear value is returned exactly once by
 * redeemPairingCode so the node can keep it locally.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, userDirName, type DataDirOptions } from "../providers/store";
import { atomicWriteFile } from "../atomic-write";

export const COMPUTERS_SCHEMA = "swarm-computers";
export const COMPUTERS_VERSION = 1;
export const MAX_COMPUTERS = 20;
export const MAX_NAME_LEN = 60;
export const MAX_ARCH_LEN = 32;
export const MAX_VERSION_LEN = 40;
export const MAX_PAIRINGS = 5;
export const COMPUTER_ID_RE = /^cmp_[a-f0-9-]{8,64}$/i;
export const PAIRING_TTL_MS = 15 * 60 * 1000;
/** A node is online when it heartbeated within this window. */
export const ONLINE_WINDOW_MS = 60 * 1000;
/**
 * Heartbeats within this much behind "now" are still fresh. Peer clocks can lag
 * by a few ms (NTP), and a 1 ms backward skew must not mark a freshly
 * heartbeating node offline. Bounded so a wildly-future timestamp still reads
 * as offline.
 */
export const MAX_BACKWARD_SKEW_MS = 5_000;
/** How many machines a heartbeat window tolerates while a laptop sleeps. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LEN = 10;
const TOKEN_BYTES = 32;

export type ComputerOS = "linux" | "macos" | "windows";
export type ComputerMode = "container" | "host";

/** The client-facing shape of a paired computer. Never contains the token hash. */
export interface Computer {
  id: string;
  name: string;
  os: ComputerOS;
  arch?: string;
  cpuCores?: number;
  memoryMb?: number;
  mode: ComputerMode;
  /** Derived from lastSeenAt, never stored. */
  online: boolean;
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
  version?: string;
}

/** Stored computer record (server only). */
interface ComputerRecord {
  id: string;
  userId: string;
  name: string;
  os: ComputerOS;
  arch?: string;
  cpuCores?: number;
  memoryMb?: number;
  mode: ComputerMode;
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
  version?: string;
  /** SHA-256 hex of the node token. Never leaves the account file. */
  nodeTokenHash: string;
}

interface PairingRecord {
  /** SHA-256 hex of the normalized pairing code. */
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

interface ComputersFile {
  schema: typeof COMPUTERS_SCHEMA;
  version: typeof COMPUTERS_VERSION;
  userId: string;
  computers: ComputerRecord[];
  pairings: PairingRecord[];
}

/** Machine facts a node reports when pairing or heartbeating. */
export interface ComputerMachine {
  name?: unknown;
  os?: unknown;
  arch?: unknown;
  cpuCores?: unknown;
  memoryMb?: unknown;
  mode?: unknown;
  version?: unknown;
}

let OVERRIDE_DIR: string | undefined;
let nowFn: () => number = Date.now;

/**
 * In-memory index: computerId -> userId.
 * Hydrated lazily or refreshed on a cache miss, updated on pairing redemption and revocation.
 * Keyed by root data directory to remain isolated across tests or differing data dirs.
 */
const computerOwnerIndices = new Map<string, Map<string, string>>();

function getIndexForRoot(root: string): Map<string, string> {
  let index = computerOwnerIndices.get(root);
  if (!index) {
    index = new Map<string, string>();
    computerOwnerIndices.set(root, index);
  }
  return index;
}

/** Test hook: clear in-memory computer index ("" resets all). */
export function clearComputerIndex(dir?: string): void {
  if (dir) {
    computerOwnerIndices.delete(dir);
  } else {
    computerOwnerIndices.clear();
  }
}

/** Scan all user files in root to populate or update the computerId -> userId index. */
function hydrateIndex(root: string, index: Map<string, string>): void {
  for (const { userId, file } of allFiles(root)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.userId !== userId || !Array.isArray(record.computers)) continue;
    for (const item of record.computers) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
        const cid = (item as Record<string, unknown>).id as string;
        if (COMPUTER_ID_RE.test(cid)) {
          index.set(cid, userId);
        }
      }
    }
  }
}

/**
 * Lookup the owning userId for computerId.
 * Checks in-memory cache first; if missing, scans all files to refresh index.
 */
function findOwnerUserId(computerId: string, options: DataDirOptions = {}): string | null {
  const root = dataDir(options);
  const index = getIndexForRoot(root);

  // If already in index, verify the user's file still contains it when read.
  const cached = index.get(computerId);
  if (cached) {
    return cached;
  }

  // Cache miss: refresh/hydrate from disk
  hydrateIndex(root, index);
  return index.get(computerId) ?? null;
}

/** Test hook: point the store at a directory ("" resets to the data dir). */
export function configureComputersStoreDir(dir: string): void {
  OVERRIDE_DIR = dir || undefined;
  if (!dir) {
    clearComputerIndex();
  }
}

/** Test hook: deterministic clock for pairing expiry and online status. */
export function configureComputersClock(now: (() => number) | undefined): void {
  nowFn = now ?? Date.now;
}

function now(): number {
  return nowFn();
}

function dataDir(options: DataDirOptions = {}): string {
  return OVERRIDE_DIR ?? resolveDataDir(options);
}

function requireUserId(userId: string): string {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 256) {
    throw new ComputersError("A signed-in user is required.", 401);
  }
  return userId;
}

/** One user's computers file. */
export function userComputersFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(dataDir(options), "users", userDirName(userId), "computers.json");
}

export class ComputersError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ComputersError";
    this.status = status;
  }
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function intInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n >= min && n <= max ? n : undefined;
}

function normalizeOS(value: unknown): ComputerOS | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "linux") return "linux";
  if (v === "macos" || v === "mac" || v === "darwin" || v === "osx") return "macos";
  if (v === "windows" || v === "win" || v === "win32" || v === "win64") return "windows";
  return undefined;
}

function normalizeMode(value: unknown): ComputerMode | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "container") return "container";
  if (v === "host" || v === "native") return "host";
  return undefined;
}

function osLabel(os: ComputerOS): string {
  return os === "macos" ? "Mac" : os === "windows" ? "Windows PC" : "Linux computer";
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Normalize a pairing code: strip separators/whitespace, uppercase. */
export function normalizePairingCode(code: unknown): string {
  if (typeof code !== "string") return "";
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Render a code as XXXXX-XXXXX for display. */
export function formatPairingCode(raw: string): string {
  const code = raw.toUpperCase();
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function newPairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LEN);
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LEN; i++) {
    out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return out;
}

function emptyFile(userId: string): ComputersFile {
  return { schema: COMPUTERS_SCHEMA, version: COMPUTERS_VERSION, userId, computers: [], pairings: [] };
}

function readFileFor(userId: string, options: DataDirOptions = {}): ComputersFile {
  requireUserId(userId);
  const file = userComputersFilePath(userId, options);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyFile(userId);
    const record = parsed as Record<string, unknown>;
    if (record.userId !== userId) {
      console.error(`[swarm-computers] ignoring computers file ${file}: owner mismatch.`);
      return emptyFile(userId);
    }
    const computers = Array.isArray(record.computers)
      ? record.computers
          .map((entry) => normalizeRecord(entry, userId))
          .filter((entry): entry is ComputerRecord => entry !== null)
          .slice(0, MAX_COMPUTERS)
      : [];
    const pairings = Array.isArray(record.pairings)
      ? record.pairings
          .map((entry) => normalizePairing(entry))
          .filter((entry): entry is PairingRecord => entry !== null)
          .slice(-MAX_PAIRINGS)
      : [];
    return { schema: COMPUTERS_SCHEMA, version: COMPUTERS_VERSION, userId, computers, pairings };
  } catch {
    return emptyFile(userId);
  }
}

function normalizeRecord(raw: unknown, userId: string): ComputerRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!COMPUTER_ID_RE.test(id)) return null;
  if (record.userId !== userId) return null;
  const name = str(record.name, MAX_NAME_LEN);
  const os = normalizeOS(record.os);
  const mode = normalizeMode(record.mode);
  if (!name || !os || !mode) return null;
  const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : 0;
  const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt;
  const hash = typeof record.nodeTokenHash === "string" ? record.nodeTokenHash : "";
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  return {
    id,
    userId,
    name,
    os,
    ...(str(record.arch, MAX_ARCH_LEN) ? { arch: str(record.arch, MAX_ARCH_LEN) } : {}),
    ...(intInRange(record.cpuCores, 1, 1024) !== undefined ? { cpuCores: intInRange(record.cpuCores, 1, 1024) } : {}),
    ...(intInRange(record.memoryMb, 128, 4_194_304) !== undefined
      ? { memoryMb: intInRange(record.memoryMb, 128, 4_194_304) }
      : {}),
    mode,
    ...(typeof record.lastSeenAt === "number" && Number.isFinite(record.lastSeenAt)
      ? { lastSeenAt: record.lastSeenAt }
      : {}),
    createdAt,
    updatedAt,
    ...(str(record.version, MAX_VERSION_LEN) ? { version: str(record.version, MAX_VERSION_LEN) } : {}),
    nodeTokenHash: hash,
  };
}

function normalizePairing(raw: unknown): PairingRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const codeHash = typeof record.codeHash === "string" ? record.codeHash : "";
  if (!/^[a-f0-9]{64}$/.test(codeHash)) return null;
  const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : 0;
  const expiresAt = typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) ? record.expiresAt : 0;
  return {
    codeHash,
    createdAt,
    expiresAt,
    ...(typeof record.usedAt === "number" && Number.isFinite(record.usedAt) ? { usedAt: record.usedAt } : {}),
  };
}

function writeFileFor(userId: string, data: ComputersFile, options: DataDirOptions = {}): void {
  const file = userComputersFilePath(userId, options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on read-only or foreign-owned mounts.
  }
  atomicWriteFile(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
}

function publicComputer(record: ComputerRecord, at: number): Computer {
  return {
    id: record.id,
    name: record.name,
    os: record.os,
    ...(record.arch ? { arch: record.arch } : {}),
    ...(record.cpuCores !== undefined ? { cpuCores: record.cpuCores } : {}),
    ...(record.memoryMb !== undefined ? { memoryMb: record.memoryMb } : {}),
    mode: record.mode,
    online: isOnline(record.lastSeenAt, at),
    ...(record.lastSeenAt !== undefined ? { lastSeenAt: record.lastSeenAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.version ? { version: record.version } : {}),
  };
}

/** True when the last heartbeat is recent enough to call the node online. */
export function isOnline(lastSeenAt: number | undefined, at: number = now()): boolean {
  if (typeof lastSeenAt !== "number") return false;
  const skew = at - lastSeenAt;
  // Allow a tiny backward skew (NTP/process clock lag) without treating a fresh
  // heartbeat as offline, while still rejecting far-future timestamps.
  return skew <= ONLINE_WINDOW_MS && skew >= -MAX_BACKWARD_SKEW_MS;
}

/** All paired computers for one account, newest first. */
export function listComputers(userId: string, options: DataDirOptions = {}): Computer[] {
  const at = now();
  return readFileFor(userId, options)
    .computers.map((record) => publicComputer(record, at))
    .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
}

/** One computer owned by the account, or null. */
export function getComputer(userId: string, computerId: string, options: DataDirOptions = {}): Computer | null {
  if (!COMPUTER_ID_RE.test(computerId)) return null;
  const record = readFileFor(userId, options).computers.find((entry) => entry.id === computerId);
  return record ? publicComputer(record, now()) : null;
}

/** Create a fresh pairing code. The raw code is returned exactly once. */
export function createPairingCode(
  userId: string,
  options: DataDirOptions = {},
): { code: string; expiresAt: number } {
  requireUserId(userId);
  const data = readFileFor(userId, options);
  const at = now();
  // Drop expired/used codes so the file never grows without bound.
  data.pairings = data.pairings.filter((entry) => !entry.usedAt && entry.expiresAt > at).slice(-(MAX_PAIRINGS - 1));
  const raw = newPairingCode();
  const expiresAt = at + PAIRING_TTL_MS;
  data.pairings.push({ codeHash: tokenHash(raw), createdAt: at, expiresAt });
  writeFileFor(userId, data, options);
  return { code: formatPairingCode(raw), expiresAt };
}

function userDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, "users"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, "users", entry.name));
  } catch {
    return [];
  }
}

/** Every readable per-account file, newest first by directory name (stable). */
function allFiles(root: string): Array<{ userId: string; file: string }> {
  const out: Array<{ userId: string; file: string }> = [];
  for (const dir of userDirs(root)) {
    const file = path.join(dir, "computers.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.userId === "string" && record.userId) out.push({ userId: record.userId, file });
  }
  return out;
}

function buildMachine(
  machine: ComputerMachine | undefined,
  fallbackOS: ComputerOS | undefined,
): { name: string; os: ComputerOS; arch?: string; cpuCores?: number; memoryMb?: number; mode: ComputerMode; version?: string } {
  const os = normalizeOS(machine?.os) ?? fallbackOS ?? "linux";
  return {
    name: str(machine?.name, MAX_NAME_LEN) ?? `${osLabel(os)} ${Math.floor(now() / 1000) % 10000}`,
    os,
    ...(str(machine?.arch, MAX_ARCH_LEN) ? { arch: str(machine?.arch, MAX_ARCH_LEN) } : {}),
    ...(intInRange(machine?.cpuCores, 1, 1024) !== undefined
      ? { cpuCores: intInRange(machine?.cpuCores, 1, 1024) }
      : {}),
    ...(intInRange(machine?.memoryMb, 128, 4_194_304) !== undefined
      ? { memoryMb: intInRange(machine?.memoryMb, 128, 4_194_304) }
      : {}),
    mode: normalizeMode(machine?.mode) ?? "host",
    ...(str(machine?.version, MAX_VERSION_LEN) ? { version: str(machine?.version, MAX_VERSION_LEN) } : {}),
  };
}

export interface PairingRedeemResult {
  userId: string;
  computer: Computer;
  /** The node's bearer token, in clear. Returned exactly once. */
  nodeToken: string;
}

/**
 * Redeem a pairing code. The code is the only credential, so an invalid,
 * expired or already-used code returns null with no distinction between the
 * cases (a caller cannot probe which accounts exist or which codes are live).
 */
export function redeemPairingCode(
  code: unknown,
  machine?: ComputerMachine,
  options: DataDirOptions = {},
): PairingRedeemResult | null {
  const normalized = normalizePairingCode(code);
  if (normalized.length !== PAIRING_CODE_LEN) return null;
  const hash = tokenHash(normalized);
  const root = dataDir(options);
  const at = now();
  for (const { userId, file } of allFiles(root)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.userId !== userId || !Array.isArray(record.pairings)) continue;
    const pairings = record.pairings as unknown[];
    let matchIndex = -1;
    for (let i = 0; i < pairings.length; i++) {
      const pairing = normalizePairing(pairings[i]);
      if (!pairing) continue;
      if (pairing.usedAt || pairing.expiresAt <= at) continue;
      if (!safeHashEqual(pairing.codeHash, hash)) continue;
      matchIndex = i;
      break;
    }
    if (matchIndex < 0) continue;

    const data = readFileFor(userId, options);
    if (data.computers.length >= MAX_COMPUTERS) {
      throw new ComputersError(`Computer limit reached (${MAX_COMPUTERS}).`, 409);
    }
    const facts = buildMachine(machine, undefined);
    const nodeToken = randomBytes(TOKEN_BYTES).toString("hex");
    const createdAt = at;
    const computer: ComputerRecord = {
      id: `cmp_${randomUUID()}`,
      userId,
      ...facts,
      lastSeenAt: at,
      createdAt,
      updatedAt: createdAt,
      nodeTokenHash: tokenHash(nodeToken),
    };
    // Mark the matching pairing used in the freshly-read file, not the stale
    // copy read above (the file could have changed between reads).
    const liveIndex = data.pairings.findIndex((entry) => entry.codeHash === hash && !entry.usedAt);
    if (liveIndex < 0) return null;
    data.pairings[liveIndex] = { ...data.pairings[liveIndex], usedAt: at };
    data.computers.push(computer);
    writeFileFor(userId, data, options);
    getIndexForRoot(root).set(computer.id, userId);
    return { userId, computer: publicComputer(computer, at), nodeToken };
  }
  return null;
}

/** Resolve a node token to its owning computer/account, without touching lastSeenAt. */
export function authenticateComputer(
  computerId: unknown,
  nodeToken: unknown,
  options: DataDirOptions = {},
): { userId: string; computer: Computer } | null {
  if (typeof computerId !== "string" || !COMPUTER_ID_RE.test(computerId)) return null;
  if (typeof nodeToken !== "string" || !/^[a-f0-9]{64}$/.test(nodeToken)) return null;

  const root = dataDir(options);
  const index = getIndexForRoot(root);

  let userId = index.get(computerId);
  if (userId) {
    const data = readFileFor(userId, options);
    const record = data.computers.find((entry) => entry.id === computerId);
    if (record && record.userId === userId) {
      if (!safeHashEqual(record.nodeTokenHash, tokenHash(nodeToken))) return null;
      return { userId, computer: publicComputer(record, now()) };
    }
    // Record not found for this cached userId (e.g. removed out-of-process or revoked), evict and fall through
    index.delete(computerId);
  }

  // Cache miss or evicted stale entry: refresh index across all user files
  hydrateIndex(root, index);
  userId = index.get(computerId);
  if (!userId) return null;

  const data = readFileFor(userId, options);
  const record = data.computers.find((entry) => entry.id === computerId);
  if (!record || record.userId !== userId) return null;
  if (!safeHashEqual(record.nodeTokenHash, tokenHash(nodeToken))) return null;
  return { userId, computer: publicComputer(record, now()) };
}

/**
 * Record a heartbeat from a node and refresh its machine facts. Returns the
 * owning account and refreshed computer, or null when the token is wrong or
 * the computer was revoked. Name is deliberately not overwritten: rename is a
 * user decision, not something the node gets to undo.
 */
export function recordHeartbeat(
  computerId: unknown,
  nodeToken: unknown,
  machine?: ComputerMachine,
  options: DataDirOptions = {},
): { userId: string; computer: Computer } | null {
  const auth = authenticateComputer(computerId, nodeToken, options);
  if (!auth) return null;
  const data = readFileFor(auth.userId, options);
  const record = data.computers.find((entry) => entry.id === auth.computer.id);
  if (!record) return null;
  const facts = buildMachine(machine, record.os);
  const at = now();
  record.os = facts.os;
  if (facts.arch) record.arch = facts.arch;
  if (facts.cpuCores !== undefined) record.cpuCores = facts.cpuCores;
  if (facts.memoryMb !== undefined) record.memoryMb = facts.memoryMb;
  record.mode = facts.mode;
  if (facts.version) record.version = facts.version;
  record.lastSeenAt = at;
  record.updatedAt = at;
  writeFileFor(auth.userId, data, options);
  return { userId: auth.userId, computer: publicComputer(record, at) };
}

/** Rename one of the account's computers. 404 when it is not theirs. */
export function renameComputer(
  userId: string,
  computerId: string,
  name: unknown,
  options: DataDirOptions = {},
): Computer | null {
  requireUserId(userId);
  if (!COMPUTER_ID_RE.test(computerId)) return null;
  const trimmed = str(name, MAX_NAME_LEN);
  if (!trimmed) throw new ComputersError("Computer name is required.", 400);
  const data = readFileFor(userId, options);
  const record = data.computers.find((entry) => entry.id === computerId);
  if (!record) return null;
  record.name = trimmed;
  record.updatedAt = now();
  writeFileFor(userId, data, options);
  return publicComputer(record, now());
}

/**
 * Revoke a computer: remove the record and its token hash. Every later
 * heartbeat/claim with the old token fails immediately. Returns false when the
 * computer is not owned by the caller.
 */
export function revokeComputer(userId: string, computerId: string, options: DataDirOptions = {}): boolean {
  requireUserId(userId);
  if (!COMPUTER_ID_RE.test(computerId)) return false;
  const data = readFileFor(userId, options);
  const before = data.computers.length;
  data.computers = data.computers.filter((entry) => entry.id !== computerId);
  if (data.computers.length === before) return false;
  writeFileFor(userId, data, options);
  getIndexForRoot(dataDir(options)).delete(computerId);
  return true;
}

/** True when the id is a well-formed computer id. */
export function isComputerId(value: unknown): value is string {
  return typeof value === "string" && COMPUTER_ID_RE.test(value);
}
