/**
 * Per-account installed Library.
 *
 * An account's library lives at
 * `<data dir>/users/<hash(userId)>/library.json` (dir mode 700, file mode
 * 600) — the same layout as roles/providers. Items are deep copies of what
 * the user added themselves or installed from the public catalog: installing
 * never keeps a live link to the publisher's item.
 *
 * Secret values are sealed with AES-256-GCM (lib/providers/secret-box),
 * bound to the owner and to the item + field. Read paths never return them:
 * `installedItemView()` exposes only `{configured, mask}` metadata.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, userDirName, type DataDirOptions } from "../providers/store";
import { open, seal, SecretBoxError } from "../providers/secret-box";
import {
  LIMITS,
  LibraryError,
  clonePayload,
  isLibraryKind,
  isRecord,
  normalizePayload,
  payloadSecretFields,
  type LibraryKind,
  type LibraryPayload,
  type SecretField,
  LIBRARY_SCHEMA,
  LIBRARY_SCHEMA_VERSION,
} from "./types";

export const USER_LIBRARY_FILE = "library.json";
const MAX_USER_ID_LEN = 256;
const MAX_ITEMS = 500;

export type ItemOrigin = "user" | "agent" | "public";

/** What is actually stored on disk for one installed item (server-only). */
export interface StoredInstalledItem {
  id: string;
  kind: LibraryKind;
  name: string;
  description: string;
  license?: string;
  /** The version this account installed; never advances by itself. */
  version: number;
  sourcePublicId?: string;
  origin: ItemOrigin;
  createdAt: number;
  updatedAt: number;
  payload: LibraryPayload;
  /** Sealed secret values, keyed by field name. Never sent to a client. */
  sealedSecrets: Record<string, string>;
  /** Non-secret last-4 masks keyed by field name, safe to show. */
  secretMasks: Record<string, string>;
}

interface UserLibraryFile {
  schema: string;
  version: number;
  userId: string;
  items: StoredInstalledItem[];
}

/** A required field as shown to the installer, with whether they filled it. */
export interface InstalledSecretField extends SecretField {
  configured: boolean;
  mask?: string;
}

/** Client-safe view of an installed item (no secret material). */
export interface InstalledItemView {
  id: string;
  kind: LibraryKind;
  name: string;
  description: string;
  license?: string;
  version: number;
  sourcePublicId?: string;
  origin: ItemOrigin;
  createdAt: number;
  updatedAt: number;
  payload: LibraryPayload;
  secretFields: InstalledSecretField[];
  /** Set when the publisher has a newer version; the copy is never auto-updated. */
  updateAvailable?: boolean;
  latestVersion?: number;
}

let DATA_DIR_OVERRIDE: string | undefined;

/** Test hook: point the library at a directory. Pass undefined to reset. */
export function configureLibraryStoreDir(dir: string | undefined): void {
  DATA_DIR_OVERRIDE = dir;
}

function requireUserId(userId: string): string {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > MAX_USER_ID_LEN) {
    throw new LibraryError("A signed-in user is required.", 401);
  }
  return userId;
}

export interface LibraryStoreOptions extends DataDirOptions {
  dataDir?: string;
}

function libraryRoot(options: LibraryStoreOptions = {}): string {
  return DATA_DIR_OVERRIDE ?? options.dataDir ?? resolveDataDir({ env: options.env });
}

/** The root holding both user libraries and the shared public catalog. */
export function resolveLibraryDataDir(options: LibraryStoreOptions = {}): string {
  return libraryRoot(options);
}

/** One user's installed-library file. */
export function userLibraryFilePath(userId: string, options: LibraryStoreOptions = {}): string {
  requireUserId(userId);
  return path.join(libraryRoot(options), "users", userDirName(userId), USER_LIBRARY_FILE);
}

function emptyLibrary(userId: string): UserLibraryFile {
  return { schema: LIBRARY_SCHEMA, version: LIBRARY_SCHEMA_VERSION, userId, items: [] };
}

/** Read a user's library. Missing or corrupt files read as an empty library. */
export function readUserLibrary(userId: string, options: LibraryStoreOptions = {}): UserLibraryFile {
  requireUserId(userId);
  const file = userLibraryFilePath(userId, options);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return emptyLibrary(userId);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) return emptyLibrary(userId);
    if (typeof parsed.userId === "string" && parsed.userId !== userId) {
      // A file copied from another account is not this account's library.
      console.error(`[swarm-library] ignoring ${file}: owner mismatch.`);
      return emptyLibrary(userId);
    }
    const items: StoredInstalledItem[] = [];
    for (const entry of parsed.items) {
      if (!isRecord(entry)) continue;
      if (typeof entry.id !== "string" || !isLibraryKind(entry.kind)) continue;
      try {
        const payload = normalizePayload(entry.kind, entry.payload);
        items.push({
          id: entry.id,
          kind: entry.kind,
          name: typeof entry.name === "string" ? entry.name : entry.id,
          description: typeof entry.description === "string" ? entry.description : "",
          ...(typeof entry.license === "string" ? { license: entry.license } : {}),
          version: typeof entry.version === "number" ? entry.version : 1,
          ...(typeof entry.sourcePublicId === "string" ? { sourcePublicId: entry.sourcePublicId } : {}),
          origin: entry.origin === "agent" ? "agent" : entry.origin === "public" ? "public" : "user",
          createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
          payload,
          sealedSecrets: isRecord(entry.sealedSecrets) ? stringRecord(entry.sealedSecrets) : {},
          secretMasks: isRecord(entry.secretMasks) ? stringRecord(entry.secretMasks) : {},
        });
      } catch {
        // Skip an item whose payload no longer validates; never fail the whole library.
      }
    }
    return { schema: LIBRARY_SCHEMA, version: LIBRARY_SCHEMA_VERSION, userId, items };
  } catch {
    return emptyLibrary(userId);
  }
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function writeUserLibrary(userId: string, items: StoredInstalledItem[], options: LibraryStoreOptions = {}): void {
  const file = userLibraryFilePath(userId, options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort on foreign mounts */
  }
  const body: UserLibraryFile = {
    schema: LIBRARY_SCHEMA,
    version: LIBRARY_SCHEMA_VERSION,
    userId,
    items: items.slice(0, MAX_ITEMS),
  };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** Mask a secret for display; the value itself never leaves the server. */
export function maskSecret(value: string): string {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

/**
 * Plan the values to (re)seal for an item add/update. A field already sealed
 * can be rotated by resupplying a value for it — that value is validated like
 * a fresh one — while configured fields that the caller did not resupply keep
 * their existing sealed value and never travel back to the client. Fields with
 * no value yet are required, so a structured 400 names what is missing.
 */
function plannedSecretValues(
  fields: readonly SecretField[],
  existingSealed: Readonly<Record<string, string>> | undefined,
  raw: unknown,
): Record<string, string> {
  const supplied = isRecord(raw) ? new Set(Object.keys(raw)) : new Set<string>();
  const required = fields.filter((field) => supplied.has(field.key) || !existingSealed?.[field.key]);
  return normalizeSecretValues(required, raw);
}

/**
 * Validate the installer-supplied values for a payload's required fields.
 * Missing fields produce a structured 400 so the UI can fill them in.
 */
export function normalizeSecretValues(fields: readonly SecretField[], raw: unknown): Record<string, string> {
  const values: Record<string, string> = {};
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(input)) throw new LibraryError("secrets must be an object.");
  const missing: string[] = [];
  for (const field of fields) {
    const value = input[field.key];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
      missing.push(field.key);
      continue;
    }
    if (typeof value !== "string") throw new LibraryError(`Secret "${field.key}" must be a string.`);
    if (value.length > LIMITS.secretValue) {
      throw new LibraryError(`Secret "${field.key}" is too long (max ${LIMITS.secretValue} characters).`);
    }
    values[field.key] = value;
  }
  if (missing.length > 0) {
    throw new LibraryError(
      `Missing required ${missing.length === 1 ? "secret" : "secrets"}: ${missing.join(", ")}.`,
      400,
      { missingFields: missing },
    );
  }
  return values;
}

function sealSecrets(
  userId: string,
  itemId: string,
  values: Record<string, string>,
): { sealedSecrets: Record<string, string>; secretMasks: Record<string, string> } {
  const sealedSecrets: Record<string, string> = {};
  const secretMasks: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    sealedSecrets[key] = seal(value, userId, `library:${itemId}:${key}`, { dataDir: resolveLibraryDataDir() });
    secretMasks[key] = maskSecret(value);
  }
  return { sealedSecrets, secretMasks };
}

/** Decrypt this account's secrets for one item. Server-side only. */
export function installedItemSecrets(userId: string, item: StoredInstalledItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, sealed] of Object.entries(item.sealedSecrets)) {
    try {
      out[key] = open(sealed, userId, `library:${item.id}:${key}`, { dataDir: resolveLibraryDataDir() });
    } catch (error) {
      // A broken/foreign secret must not make the whole library unreadable.
      if (error instanceof SecretBoxError) continue;
      continue;
    }
  }
  return out;
}

/**
 * Decrypt this account's secrets for one item, failing closed on any broken
 * or foreign sealed value. Seeding a run must never silently omit a secret:
 * the caller gets every sealed value back or an error naming the item and the
 * field, never the value.
 */
export function requireItemSecrets(userId: string, item: StoredInstalledItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, sealed] of Object.entries(item.sealedSecrets)) {
    try {
      out[key] = open(sealed, userId, `library:${item.id}:${key}`, { dataDir: resolveLibraryDataDir() });
    } catch {
      throw new LibraryError(
        `Library item "${item.name}" could not be seeded: the sealed secret for "${key}" is broken or belongs to another account. Remove the item and install it again with a new ${key} value.`,
        400,
        { field: key },
      );
    }
  }
  return out;
}

/** Client-safe projection: strips sealed values and adds configured/mask metadata. */
export function installedItemView(item: StoredInstalledItem): InstalledItemView {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    description: item.description,
    ...(item.license ? { license: item.license } : {}),
    version: item.version,
    ...(item.sourcePublicId ? { sourcePublicId: item.sourcePublicId } : {}),
    origin: item.origin,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    payload: clonePayload(item.payload),
    secretFields: payloadSecretFields(item.payload).map((field) => {
      const mask = item.secretMasks[field.key];
      return { ...field, configured: Boolean(item.sealedSecrets[field.key]), ...(mask ? { mask } : {}) };
    }),
  };
}

export function listInstalledItems(userId: string, options: LibraryStoreOptions = {}): InstalledItemView[] {
  return readUserLibrary(userId, options).items.map(installedItemView);
}

export function getInstalledItem(
  userId: string,
  id: string,
  options: LibraryStoreOptions = {},
): InstalledItemView | null {
  const item = readUserLibrary(userId, options).items.find((entry) => entry.id === id);
  return item ? installedItemView(item) : null;
}

/** Server-only read used by the runtime and by publish-from-library. */
export function getStoredItem(
  userId: string,
  id: string,
  options: LibraryStoreOptions = {},
): StoredInstalledItem | null {
  return readUserLibrary(userId, options).items.find((entry) => entry.id === id) ?? null;
}

export interface AddItemInput {
  kind: LibraryKind;
  name: string;
  description?: string;
  license?: string;
  payload: unknown;
  /** Values for payload.requiredFields; sealed in this account. */
  secrets?: unknown;
  origin?: ItemOrigin;
  /** Fixed id, used by public install so re-installing updates one copy. */
  id?: string;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item"
  );
}

function itemId(kind: LibraryKind, name: string): string {
  return `${kind}-${slug(name)}-${randomBytes(4).toString("hex")}`;
}

function cleanName(value: unknown, fallback?: string): string {
  const raw = typeof value === "string" ? value.trim() : fallback ?? "";
  if (!raw) throw new LibraryError("name is required.");
  if (raw.length > LIMITS.name) throw new LibraryError(`name must be at most ${LIMITS.name} characters.`);
  return raw;
}

function cleanDescription(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new LibraryError("description must be a string.");
  const out = value.trim();
  if (out.length > LIMITS.description) {
    throw new LibraryError(`description must be at most ${LIMITS.description} characters.`);
  }
  return out;
}

function cleanLicense(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new LibraryError("license must be a string.");
  const out = value.trim();
  if (out.length > LIMITS.license) throw new LibraryError(`license must be at most ${LIMITS.license} characters.`);
  return out;
}

/**
 * Add a custom item to the caller's library (the form editor, or a tool the
 * agent wrote). Payload validation is shared with publication, so an item
 * that cannot be published also cannot be installed.
 */
export function addInstalledItem(
  userId: string,
  input: AddItemInput,
  options: LibraryStoreOptions = {},
): InstalledItemView {
  requireUserId(userId);
  if (!isLibraryKind(input.kind)) throw new LibraryError("kind must be skill, tool, mcp or connector.");
  const payload = normalizePayload(input.kind, input.payload);
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  const license = cleanLicense(input.license);
  const id = input.id ?? itemId(input.kind, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new LibraryError("id is not a safe item id.");
  const now = Date.now();
  const library = readUserLibrary(userId, options);
  const existingIndex = library.items.findIndex((item) => item.id === id);
  const existing = existingIndex >= 0 ? library.items[existingIndex] : null;
  // Fields already configured on the existing item do not need to be resent
  // when the user edits the rest of it.
  const required = payloadSecretFields(payload);
  const values = plannedSecretValues(required, existing?.sealedSecrets, input.secrets);
  const { sealedSecrets, secretMasks } = sealSecrets(userId, id, values);
  // Re-adding keeps secrets the caller did not resupply.
  if (existing) {
    for (const [key, sealed] of Object.entries(existing.sealedSecrets)) {
      if (!(key in sealedSecrets)) sealedSecrets[key] = sealed;
    }
    for (const [key, mask] of Object.entries(existing.secretMasks)) {
      if (!(key in secretMasks)) secretMasks[key] = mask;
    }
  }
  const item: StoredInstalledItem = {
    id,
    kind: input.kind,
    name,
    description,
    ...(license ? { license } : {}),
    version: existing ? existing.version : 1,
    ...(existing?.sourcePublicId ? { sourcePublicId: existing.sourcePublicId } : {}),
    origin: input.origin ?? existing?.origin ?? "user",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    payload,
    sealedSecrets,
    secretMasks,
  };
  const items = [...library.items];
  if (existingIndex >= 0) items[existingIndex] = item;
  else items.unshift(item);
  writeUserLibrary(userId, items, options);
  return installedItemView(item);
}

/** Explicitly update an installed copy to a public payload (install/update). */
export function replaceInstalledCopy(
  userId: string,
  input: {
    id: string;
    kind: LibraryKind;
    name: string;
    description: string;
    license?: string;
    version: number;
    sourcePublicId: string;
    payload: LibraryPayload;
    secrets?: unknown;
  },
  options: LibraryStoreOptions = {},
): InstalledItemView {
  requireUserId(userId);
  const payload = normalizePayload(input.kind, input.payload);
  const library = readUserLibrary(userId, options);
  const existingIndex = library.items.findIndex((item) => item.id === input.id);
  const existing = existingIndex >= 0 ? library.items[existingIndex] : null;
  const required = payloadSecretFields(payload);
  const values = plannedSecretValues(required, existing?.sealedSecrets, input.secrets);
  const { sealedSecrets, secretMasks } = sealSecrets(userId, input.id, values);
  if (existing) {
    for (const [key, sealed] of Object.entries(existing.sealedSecrets)) {
      if (!(key in sealedSecrets)) sealedSecrets[key] = sealed;
    }
    for (const [key, mask] of Object.entries(existing.secretMasks)) {
      if (!(key in secretMasks)) secretMasks[key] = mask;
    }
  }
  const now = Date.now();
  const item: StoredInstalledItem = {
    id: input.id,
    kind: input.kind,
    name: cleanName(input.name),
    description: cleanDescription(input.description),
    ...(input.license ? { license: cleanLicense(input.license) } : {}),
    version: input.version,
    sourcePublicId: input.sourcePublicId,
    origin: "public",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    payload,
    sealedSecrets,
    secretMasks,
  };
  const items = [...library.items];
  if (existingIndex >= 0) items[existingIndex] = item;
  else items.unshift(item);
  writeUserLibrary(userId, items, options);
  return installedItemView(item);
}

/** Remove one item from the caller's library. Returns false when absent. */
export function deleteInstalledItem(
  userId: string,
  id: string,
  options: LibraryStoreOptions = {},
): boolean {
  const library = readUserLibrary(userId, options);
  const items = library.items.filter((item) => item.id !== id);
  if (items.length === library.items.length) return false;
  writeUserLibrary(userId, items, options);
  return true;
}

/** Stable local id a public install uses, so re-installing updates one copy. */
export function publicInstallId(publicId: string): string {
  const digest = createHash("sha256").update(`swarm-public-install:${publicId}`).digest("hex").slice(0, 12);
  return `pub-${digest}`;
}
