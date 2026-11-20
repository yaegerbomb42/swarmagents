/**
 * Durable cooldown/backoff state for provider API keys.
 *
 * When a provider answers with 429 (or another transient failure) the router
 * puts that key on cooldown so the next request rotates to another key. That
 * state used to live in memory only, so a server restart immediately hammered
 * the very same rate-limited key again. This module persists the state under
 * SWARM_HOME so it survives a restart.
 *
 * Key material is never written to disk: every record is identified by a
 * one-way hash of the key (see `hashProviderKey`). The slot label
 * ("anthropic:key-2") is not used as an identifier because the order of a
 * provider's keys may change between restarts, while the hash does not.
 *
 * Writes are atomic: the new state is written to a temporary file in the same
 * directory and then renamed over the target, so a crash mid-write can never
 * leave a half-written file behind.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Name of the state file inside the swarm home directory. */
export const COOLDOWN_FILE_NAME = "provider_cooldowns.json";

/**
 * Default cool-down for a provider that answered 402 (payment/quota
 * exhausted): it is skipped for this long instead of being retried on every
 * call. Configurable via SWARM_QUOTA_COOLDOWN_MS.
 */
export const DEFAULT_QUOTA_COOLDOWN_MS = 15 * 60_000;

/** Schema version of the persisted file. */
export const COOLDOWN_FILE_VERSION = 1;

/** Number of hex characters kept from the sha256 digest (128 bits). */
const KEY_HASH_LENGTH = 32;

/** One persisted cooldown/backoff record for a single provider key. */
export interface PersistedCooldown {
  /** Provider the key belongs to. */
  provider: string;
  /** One-way id of the key. Never the key itself. */
  keyHash: string;
  /** Epoch ms at which the key becomes usable again. */
  cooldownUntil: number;
  /** Consecutive failures, i.e. the current exponential backoff exponent. */
  consecutiveFailures: number;
  /** Total failures observed for the key. */
  failures: number;
  /** HTTP status of the last failure, when there was one. */
  lastStatus?: number;
  /** Error kind of the last failure, when there was one. */
  lastErrorKind?: string;
  /** Epoch ms of the last state change. */
  updatedAt: number;
}

/** On-disk shape of the cooldown state file. */
export interface CooldownFileContents {
  version: number;
  entries: PersistedCooldown[];
}

export interface CooldownStoreOptions {
  /** Explicit file path. Defaults to `<SWARM_HOME>/provider_cooldowns.json`. */
  file?: string;
  /** Injectable clock, used for expiry checks. */
  now?: () => number;
  /** Environment source for SWARM_HOME. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * One-way identifier for a key. The digest is domain-separated so it cannot
 * be reused to probe for the key material elsewhere, and it is truncated to
 * 128 bits which is plenty for identifying a key slot.
 */
export function hashProviderKey(key: string): string {
  return createHash("sha256")
    .update(`swarm-provider-key:v${COOLDOWN_FILE_VERSION}:${key}`)
    .digest("hex")
    .slice(0, KEY_HASH_LENGTH);
}

/** Directory holding the swarm state. Mirrors the telemetry run directory. */
export function resolveCooldownDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.SWARM_HOME?.trim();
  if (home) return home;
  return path.join(os.homedir(), ".swarmagents");
}

/** Full path of the cooldown state file. */
export function resolveCooldownFile(env: Record<string, string | undefined> = process.env): string {
  const override = env.SWARM_COOLDOWN_FILE?.trim();
  if (override) return override;
  return path.join(resolveCooldownDir(env), COOLDOWN_FILE_NAME);
}

let fileOverride: string | undefined;

/**
 * Test/deployment hook: point the cooldown state file somewhere else. Pass
 * undefined to fall back to `<SWARM_HOME>/provider_cooldowns.json` again.
 */
export function configureCooldownFile(file: string | undefined): void {
  fileOverride = file;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate one persisted record. Malformed records are dropped. */
function parseEntry(value: unknown): PersistedCooldown | null {
  if (!isRecord(value)) return null;
  const provider = optionalString(value.provider);
  const keyHash = optionalString(value.keyHash);
  const cooldownUntil = optionalNumber(value.cooldownUntil);
  if (!provider || !keyHash || cooldownUntil === undefined || cooldownUntil <= 0) return null;

  const lastStatus = optionalNumber(value.lastStatus);
  const lastErrorKind = optionalString(value.lastErrorKind);

  return {
    provider,
    keyHash,
    cooldownUntil,
    consecutiveFailures: optionalNumber(value.consecutiveFailures) ?? 1,
    failures: optionalNumber(value.failures) ?? 1,
    ...(lastStatus !== undefined ? { lastStatus } : {}),
    ...(lastErrorKind !== undefined ? { lastErrorKind } : {}),
    updatedAt: optionalNumber(value.updatedAt) ?? cooldownUntil,
  };
}

/** Parse the file contents. A malformed file yields no records. */
export function parseCooldownFile(raw: string): PersistedCooldown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const entries = parsed.entries;
  if (!Array.isArray(entries)) return [];
  const out: PersistedCooldown[] = [];
  for (const entry of entries) {
    const record = parseEntry(entry);
    if (record) out.push(record);
  }
  return out;
}

/** Signature of a record set, ignoring the bookkeeping timestamp. */
function signature(entries: readonly PersistedCooldown[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      provider: entry.provider,
      keyHash: entry.keyHash,
      cooldownUntil: entry.cooldownUntil,
      consecutiveFailures: entry.consecutiveFailures,
      failures: entry.failures,
      lastStatus: entry.lastStatus ?? null,
      lastErrorKind: entry.lastErrorKind ?? null,
    }))
  );
}

/**
 * Reads and writes the persisted cooldown state.
 *
 * The store is intentionally forgiving: a missing or corrupt file is treated
 * as "no state" instead of an error, because losing the cooldown history must
 * never stop the router from serving requests.
 */
export class CooldownStore {
  /** Absolute path of the state file. */
  readonly file: string;

  private readonly now: () => number;
  private lastSignature: string | undefined;
  private tempCounter = 0;
  private warned = false;

  constructor(options: CooldownStoreOptions = {}) {
    this.file = options.file ?? fileOverride ?? resolveCooldownFile(options.env ?? process.env);
    this.now = options.now ?? Date.now;
  }

  /**
   * Load the persisted records. Expired entries (their cooldown elapsed) are
   * pruned: they are not returned and they are dropped from the file, so the
   * state file cannot grow without bound.
   */
  load(): PersistedCooldown[] {
    const raw = this.read();
    if (raw === null) return [];

    const entries = parseCooldownFile(raw);
    const now = this.now();
    const active = entries.filter((entry) => entry.cooldownUntil > now);
    if (active.length !== entries.length) this.write(active, true);
    return active;
  }

  /** Replace the persisted state. Writes are atomic. */
  save(entries: readonly PersistedCooldown[]): void {
    this.write(entries);
  }

  private read(): string | null {
    try {
      if (!fs.existsSync(this.file)) return null;
      return fs.readFileSync(this.file, "utf-8");
    } catch (err) {
      this.warn(`could not read ${this.file}:`, err);
      return null;
    }
  }

  private write(entries: readonly PersistedCooldown[], force = false): void {
    const contents: CooldownFileContents = {
      version: COOLDOWN_FILE_VERSION,
      entries: [...entries],
    };
    const body = `${JSON.stringify(contents, null, 2)}\n`;

    const nextSignature = signature(contents.entries);
    if (!force && nextSignature === this.lastSignature) return;

    const dir = path.dirname(this.file);
    const tmp = `${this.file}.tmp.${process.pid}.${this.tempCounter++}`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, body, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // The temp file is best-effort cleanup.
      }
      this.warn(`could not write ${this.file}:`, err);
      return;
    }
    this.lastSignature = nextSignature;
  }

  private warn(message: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[swarm-cooldowns] ${message} ${detail}`);
  }
}
