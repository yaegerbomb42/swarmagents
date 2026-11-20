/**
 * The shared public catalog: published skills, tools and MCP servers.
 *
 * The catalog is a server-side file store at
 * `<data dir>/public-library/catalog.json`, with one record per item. Every
 * record has an `ownerId` (the publisher) that is never returned to clients —
 * clients see an author handle instead.
 *
 * Publishing is copy-only: a public payload contains the full SKILL.md/code
 * and the *names* of the secrets the installer must supply, never a secret
 * value. Installing deep-copies the current version into the installer's own
 * library; later publisher versions only make `updateAvailable` true. Nothing
 * auto-updates.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
  type ModerationState,
  type SecretField,
  LIBRARY_SCHEMA,
  LIBRARY_SCHEMA_VERSION,
} from "./types";
import {
  publicInstallId,
  replaceInstalledCopy,
  type InstalledItemView,
  type LibraryStoreOptions,
  resolveLibraryDataDir,
} from "./user-store";
import { parseProofBundle, proofView, verifyProofBundle, buildProofForPublish, type ProofBundle, type ProofView } from "./proof";

export const PUBLIC_CATALOG_FILE = "catalog.json";
const MAX_PUBLIC_ITEMS = 10_000;
const MAX_VERSIONS = 100;
const MAX_REPORTS = 100;

export interface LibraryReport {
  /** Reporter user id; never returned to a client. */
  userId: string;
  reason: string;
  at: number;
}

export interface PublicVersion {
  version: number;
  createdAt: number;
  payload: LibraryPayload;
  changelog?: string;
  /**
   * F4 signed proof-of-run bundle for this exact version, when the publisher
   * attached one. Verified on read (see publicItemSummary/detail) — a stale
   * or tampered bundle never displays as verified.
   */
  proof?: ProofBundle;
}

/** The full on-disk record (server-only fields included). */
export interface PublicItemRecord {
  id: string;
  kind: LibraryKind;
  /** Publisher user id; never sent to clients. */
  ownerId: string;
  authorHandle: string;
  name: string;
  description: string;
  license: string;
  createdAt: number;
  updatedAt: number;
  currentVersion: number;
  installs: number;
  moderation: ModerationState;
  reports: LibraryReport[];
  versions: PublicVersion[];
  /** Users who installed at least once; used for the unique install count. */
  installerIds: string[];
}

interface PublicCatalogFile {
  schema: string;
  version: number;
  items: PublicItemRecord[];
}

/** Client-safe listing row. */
export interface PublicItemSummary {
  id: string;
  kind: LibraryKind;
  name: string;
  description: string;
  license: string;
  authorHandle: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  installs: number;
  /** New submissions stay "unreviewed" until an admin reviews them. */
  moderation: ModerationState;
  reported: boolean;
  reportCount: number;
  /**
   * F4: true only when the current version carries a signed proof bundle
   * that verifies against this exact version's payload. Never true for an
   * unsigned, tampered, or stale bundle.
   */
  proofVerified: boolean;
}

/** Client-safe detail with the full install preview. */
export interface PublicItemDetail extends PublicItemSummary {
  payload: LibraryPayload;
  requiredFields: SecretField[];
  isOwner: boolean;
  canUnpublish: boolean;
  /** Verified proof bundle for the current version, when one verifies. */
  proof?: ProofView;
}

export interface PublicListOptions {
  query?: string;
  kind?: LibraryKind | "all";
  sort?: "installs" | "newest" | "updated" | "name";
  limit?: number;
  offset?: number;
}

export function publicCatalogFilePath(options: LibraryStoreOptions = {}): string {
  return path.join(resolveLibraryDataDir(options), "public-library", PUBLIC_CATALOG_FILE);
}

function emptyCatalog(): PublicCatalogFile {
  return { schema: LIBRARY_SCHEMA, version: LIBRARY_SCHEMA_VERSION, items: [] };
}

export function readPublicCatalog(options: LibraryStoreOptions = {}): PublicCatalogFile {
  const file = publicCatalogFilePath(options);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return emptyCatalog();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) return emptyCatalog();
    const items: PublicItemRecord[] = [];
    for (const entry of parsed.items) {
      if (!isRecord(entry)) continue;
      if (typeof entry.id !== "string" || !isLibraryKind(entry.kind)) continue;
      const versions: PublicVersion[] = [];
      if (Array.isArray(entry.versions)) {
        for (const version of entry.versions) {
          if (!isRecord(version) || typeof version.version !== "number") continue;
          try {
            versions.push({
              version: version.version,
              createdAt: typeof version.createdAt === "number" ? version.createdAt : Date.now(),
              payload: normalizePayload(entry.kind, version.payload),
              ...(typeof version.changelog === "string" ? { changelog: version.changelog } : {}),
              ...(version.proof !== undefined
                ? (() => {
                    const proof = parseProofBundle(version.proof);
                    return proof ? { proof } : {};
                  })()
                : {}),
            });
          } catch {
            /* drop an invalid version */
          }
        }
      }
      if (versions.length === 0) continue;
      versions.sort((a, b) => a.version - b.version);
      const latest = versions[versions.length - 1];
      const moderation: ModerationState =
        entry.moderation === "reviewed" || entry.moderation === "unpublished"
          ? entry.moderation
          : "unreviewed";
      items.push({
        id: entry.id,
        kind: entry.kind,
        ownerId: typeof entry.ownerId === "string" ? entry.ownerId : "",
        authorHandle:
          typeof entry.authorHandle === "string" && entry.authorHandle
            ? entry.authorHandle
            : authorHandleFor(typeof entry.ownerId === "string" ? entry.ownerId : "anonymous"),
        name: typeof entry.name === "string" ? entry.name : entry.id,
        description: typeof entry.description === "string" ? entry.description : "",
        license: typeof entry.license === "string" ? entry.license : "",
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
        currentVersion: latest.version,
        installs: typeof entry.installs === "number" ? entry.installs : 0,
        moderation,
        reports: Array.isArray(entry.reports)
          ? entry.reports
              .filter((report): report is Record<string, unknown> => isRecord(report))
              .map((report) => ({
                userId: typeof report.userId === "string" ? report.userId : "unknown",
                reason: typeof report.reason === "string" ? report.reason : "",
                at: typeof report.at === "number" ? report.at : 0,
              }))
              .slice(0, MAX_REPORTS)
          : [],
        versions,
        installerIds: Array.isArray(entry.installerIds)
          ? entry.installerIds.filter((id): id is string => typeof id === "string")
          : [],
      });
    }
    return { schema: LIBRARY_SCHEMA, version: LIBRARY_SCHEMA_VERSION, items };
  } catch {
    return emptyCatalog();
  }
}

function writePublicCatalog(catalog: PublicCatalogFile, options: LibraryStoreOptions = {}): void {
  const file = publicCatalogFilePath(options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  const body: PublicCatalogFile = {
    schema: LIBRARY_SCHEMA,
    version: LIBRARY_SCHEMA_VERSION,
    items: catalog.items.slice(0, MAX_PUBLIC_ITEMS),
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

/** A stable, non-identifying author handle derived from the publisher id. */
export function authorHandleFor(userId: string): string {
  let base = userId.trim();
  if (base.startsWith("local_")) base = base.slice("local_".length);
  const at = base.indexOf("@");
  if (at > 0) base = base.slice(0, at);
  base = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, LIMITS.authorHandle);
  return base || "anonymous";
}

function cleanText(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (!required) return "";
    throw new LibraryError(`${field} is required.`);
  }
  if (typeof value !== "string") throw new LibraryError(`${field} must be a string.`);
  const out = value.trim();
  if (!out) {
    if (!required) return "";
    throw new LibraryError(`${field} is required.`);
  }
  if (out.length > max) throw new LibraryError(`${field} must be at most ${max} characters.`);
  return out;
}

export interface PublishInput {
  kind: LibraryKind;
  name: string;
  description?: string;
  license?: string;
  payload: unknown;
  changelog?: string;
}

function newPublicId(): string {
  return `pub_${randomBytes(9).toString("base64url")}`;
}

/**
 * Publish a new item. The caller supplies an already-resolved payload (the
 * route resolves `sourceItemId` by reading the caller's own library, which
 * never contains the sealed values in the payload).
 */
export function publishItem(ownerId: string, input: PublishInput, options: LibraryStoreOptions = {}): PublicItemRecord {
  if (!ownerId) throw new LibraryError("A signed-in user is required.", 401);
  if (!isLibraryKind(input.kind)) throw new LibraryError("kind must be skill, tool, mcp or connector.");
  const payload = normalizePayload(input.kind, input.payload);
  const name = cleanText(input.name, "name", LIMITS.name, true);
  const description = cleanText(input.description, "description", LIMITS.description, false);
  const license = cleanText(input.license, "license", LIMITS.license, false);
  const now = Date.now();
  const version: PublicVersion = {
    version: 1,
    createdAt: now,
    payload,
    ...(input.changelog ? { changelog: cleanText(input.changelog, "changelog", 500, false) } : {}),
  };
  const record: PublicItemRecord = {
    id: newPublicId(),
    kind: input.kind,
    ownerId,
    authorHandle: authorHandleFor(ownerId),
    name,
    description,
    license,
    createdAt: now,
    updatedAt: now,
    currentVersion: 1,
    installs: 0,
    // Every new submission is visible but explicitly labelled unreviewed.
    moderation: "unreviewed",
    reports: [],
    versions: [version],
    installerIds: [],
  };
  const catalog = readPublicCatalog(options);
  catalog.items.unshift(record);
  writePublicCatalog(catalog, options);
  return record;
}

/** The owner publishes a new version. Installers are notified, never updated. */
export function publishVersion(
  publicId: string,
  ownerId: string,
  input: PublishInput,
  options: LibraryStoreOptions = {},
): PublicItemRecord {
  const catalog = readPublicCatalog(options);
  const index = catalog.items.findIndex((item) => item.id === publicId);
  if (index < 0) throw new LibraryError("Item not found.", 404);
  const record = catalog.items[index];
  if (record.ownerId !== ownerId) {
    throw new LibraryError("Only the publisher can publish a new version.", 403);
  }
  if (record.moderation === "unpublished") throw new LibraryError("This item is unpublished.", 409);
  const payload = normalizePayload(record.kind, input.payload);
  const now = Date.now();
  const nextVersion = record.currentVersion + 1;
  record.versions.push({
    version: nextVersion,
    createdAt: now,
    payload,
    ...(input.changelog ? { changelog: cleanText(input.changelog, "changelog", 500, false) } : {}),
  });
  if (record.versions.length > MAX_VERSIONS) record.versions = record.versions.slice(-MAX_VERSIONS);
  record.currentVersion = nextVersion;
  record.updatedAt = now;
  if (typeof input.name === "string" && input.name.trim()) {
    record.name = cleanText(input.name, "name", LIMITS.name, true);
  }
  if (input.description !== undefined) {
    record.description = cleanText(input.description, "description", LIMITS.description, false);
  }
  if (input.license !== undefined) record.license = cleanText(input.license, "license", LIMITS.license, false);
  catalog.items[index] = record;
  writePublicCatalog(catalog, options);
  return record;
}

export function latestVersion(record: PublicItemRecord): PublicVersion {
  return record.versions.find((version) => version.version === record.currentVersion) ?? record.versions[record.versions.length - 1];
}

/** F4: verify the current version's proof bundle (if any) against its payload. */
export function verifiedProofFor(record: PublicItemRecord): ProofBundle | null {
  const version = latestVersion(record);
  if (!version.proof) return null;
  return verifyProofBundle(version.proof, {
    publicId: record.id,
    version: version.version,
    payload: version.payload,
  })
    ? version.proof
    : null;
}

/**
 * F4: record a signed proof bundle on one version (after the publish route
 * built and signed it). The bundle's shots are already stored by the caller.
 */
export function setVersionProof(
  publicId: string,
  versionNumber: number,
  proof: ProofBundle,
  options: LibraryStoreOptions = {},
): PublicItemRecord {
  const catalog = readPublicCatalog(options);
  const index = catalog.items.findIndex((item) => item.id === publicId);
  if (index < 0) throw new LibraryError("Item not found.", 404);
  const record = catalog.items[index];
  const version = record.versions.find((entry) => entry.version === versionNumber);
  if (!version) throw new LibraryError("Version not found.", 404);
  version.proof = proof;
  catalog.items[index] = record;
  writePublicCatalog(catalog, options);
  return record;
}

/**
 * F4: build, sign and attach a proof bundle for the record's current
 * version from the publisher's own finished run. Throws when the run has
 * no report, is not the publisher's, did not finish, or the server secret
 * is unset — the publish itself is unaffected; the route reports the
 * failure as `proofError` instead of failing the publish.
 */
export function attachProofToCurrentVersion(
  record: PublicItemRecord,
  ownerId: string,
  proofRunId: string,
  options: LibraryStoreOptions = {},
): PublicItemRecord {
  const version = latestVersion(record);
  const built = buildProofForPublish({
    ownerId,
    publicId: record.id,
    version: version.version,
    kind: record.kind,
    name: record.name,
    payload: version.payload,
    proofRunId,
    storeOptions: options,
  });
  return setVersionProof(record.id, version.version, built.bundle, options);
}

export function publicItemSummary(record: PublicItemRecord): PublicItemSummary {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    description: record.description,
    license: record.license,
    authorHandle: record.authorHandle,
    version: record.currentVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    installs: record.installs,
    moderation: record.moderation,
    reported: record.reports.length > 0,
    reportCount: record.reports.length,
    proofVerified: verifiedProofFor(record) !== null,
  };
}

/** Detail view; unpublished items stay visible only to their owner/admin. */
export function publicItemDetail(
  record: PublicItemRecord,
  viewerId: string,
  admin: boolean,
): PublicItemDetail {
  const version = latestVersion(record);
  const proof = verifiedProofFor(record);
  return {
    ...publicItemSummary(record),
    payload: clonePayload(version.payload),
    requiredFields: payloadSecretFields(version.payload),
    isOwner: record.ownerId === viewerId,
    canUnpublish: admin || record.ownerId === viewerId,
    ...(proof ? { proof: proofView(proof) } : {}),
  };
}

export function findPublicItem(publicId: string, options: LibraryStoreOptions = {}): PublicItemRecord | null {
  return readPublicCatalog(options).items.find((item) => item.id === publicId) ?? null;
}

/** Browse the catalog. Unpublished items are never listed. */
export function listPublicItems(
  opts: PublicListOptions = {},
  options: LibraryStoreOptions = {},
): { items: PublicItemSummary[]; total: number } {
  const query = (opts.query ?? "").trim().toLowerCase();
  const kind = opts.kind ?? "all";
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const items = readPublicCatalog(options).items.filter((item) => {
    if (item.moderation === "unpublished") return false;
    if (kind !== "all" && item.kind !== kind) return false;
    if (!query) return true;
    return [item.name, item.description, item.authorHandle, item.kind, item.license]
      .join("\n")
      .toLowerCase()
      .includes(query);
  });
  const sort = opts.sort ?? "installs";
  items.sort((a, b) => {
    if (sort === "newest") return b.createdAt - a.createdAt || b.installs - a.installs;
    if (sort === "updated") return b.updatedAt - a.updatedAt || b.installs - a.installs;
    if (sort === "name") return a.name.localeCompare(b.name);
    // installs: most-installed first, newest as the tie-break.
    return b.installs - a.installs || b.createdAt - a.createdAt;
  });
  return {
    items: items.slice(offset, offset + limit).map(publicItemSummary),
    total: items.length,
  };
}

export interface InstallResult {
  item: InstalledItemView;
  publicItem: PublicItemSummary;
}

/**
 * Copy the current version of a public item into `installerId`'s library.
 * Repeated installs by the same account update their own copy and never
 * inflate the unique install count twice.
 */
export function installPublicItem(
  publicId: string,
  installerId: string,
  secrets: unknown,
  options: LibraryStoreOptions = {},
): InstallResult {
  if (!installerId) throw new LibraryError("A signed-in user is required.", 401);
  const catalog = readPublicCatalog(options);
  const record = catalog.items.find((item) => item.id === publicId);
  if (!record) throw new LibraryError("Item not found.", 404);
  if (record.moderation === "unpublished") throw new LibraryError("Item not found.", 404);
  const version = latestVersion(record);
  const payload = clonePayload(version.payload);
  const item = replaceInstalledCopy(
    installerId,
    {
      id: publicInstallId(record.id),
      kind: record.kind,
      name: record.name,
      description: record.description,
      ...(record.license ? { license: record.license } : {}),
      version: record.currentVersion,
      sourcePublicId: record.id,
      payload,
      secrets,
    },
    options,
  );
  let changed = false;
  if (!record.installerIds.includes(installerId)) {
    record.installerIds.push(installerId);
    record.installs = record.installerIds.length;
    changed = true;
  }
  if (changed) writePublicCatalog(catalog, options);
  return { item, publicItem: publicItemSummary(record) };
}

/** Record (or replace) one account's report. Reporter identity stays private. */
export function reportPublicItem(
  publicId: string,
  reporterId: string,
  reason: unknown,
  options: LibraryStoreOptions = {},
): { reportCount: number; moderation: ModerationState } {
  if (!reporterId) throw new LibraryError("A signed-in user is required.", 401);
  const text = cleanText(reason, "reason", LIMITS.reason, true);
  const catalog = readPublicCatalog(options);
  const record = catalog.items.find((item) => item.id === publicId);
  if (!record) throw new LibraryError("Item not found.", 404);
  if (record.moderation === "unpublished") throw new LibraryError("Item not found.", 404);
  record.reports = record.reports.filter((report) => report.userId !== reporterId);
  record.reports.push({ userId: reporterId, reason: text, at: Date.now() });
  if (record.reports.length > MAX_REPORTS) record.reports = record.reports.slice(-MAX_REPORTS);
  writePublicCatalog(catalog, options);
  return { reportCount: record.reports.length, moderation: record.moderation };
}

/**
 * Take an item out of the public catalog. Admin-only for moderation, but a
 * publisher may always withdraw their own item.
 */
export function unpublishPublicItem(
  publicId: string,
  actorId: string,
  opts: { admin: boolean },
  options: LibraryStoreOptions = {},
): PublicItemSummary {
  if (!actorId) throw new LibraryError("A signed-in user is required.", 401);
  const catalog = readPublicCatalog(options);
  const record = catalog.items.find((item) => item.id === publicId);
  if (!record) throw new LibraryError("Item not found.", 404);
  if (!opts.admin && record.ownerId !== actorId) {
    throw new LibraryError("Only an administrator can unpublish this item.", 403);
  }
  record.moderation = "unpublished";
  record.updatedAt = Date.now();
  writePublicCatalog(catalog, options);
  return publicItemSummary(record);
}

/** Admin-only review: drop the "unreviewed" label after a human check. */
export function reviewPublicItem(
  publicId: string,
  actorId: string,
  opts: { admin: boolean },
  options: LibraryStoreOptions = {},
): PublicItemSummary {
  if (!opts.admin) throw new LibraryError("Only an administrator can review items.", 403);
  const catalog = readPublicCatalog(options);
  const record = catalog.items.find((item) => item.id === publicId);
  if (!record) throw new LibraryError("Item not found.", 404);
  if (record.moderation === "unpublished") throw new LibraryError("This item is unpublished.", 409);
  record.moderation = "reviewed";
  record.updatedAt = Date.now();
  writePublicCatalog(catalog, options);
  return publicItemSummary(record);
}

/** True when an installed copy is behind the publisher's current version. */
export function updateAvailableFor(
  item: { sourcePublicId?: string; version: number },
  options: LibraryStoreOptions = {},
): { updateAvailable: boolean; latestVersion?: number } {
  if (!item.sourcePublicId) return { updateAvailable: false };
  const record = findPublicItem(item.sourcePublicId, options);
  if (!record || record.moderation === "unpublished") return { updateAvailable: false };
  return {
    updateAvailable: record.currentVersion > item.version,
    latestVersion: record.currentVersion,
  };
}
