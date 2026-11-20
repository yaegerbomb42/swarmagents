/**
 * One-off migration: move the legacy server-wide providers file
 * (`<data dir>/providers.json` or SWARM_PROVIDERS_FILE) into the owner's
 * account, then rename it to `<file>.migrated` so it is never read again.
 *
 * The owner is SWARM_OWNER_EMAIL (default james@swarmagents.codes). The
 * migration only runs when that owner already has an account: parking the
 * keys under an id nobody holds yet would hand them to whoever signs up with
 * that email first. Until then the legacy file is simply left alone — it is
 * not read by any route, so there is no server-wide fallback in the meantime.
 *
 * Idempotent: once the file is renamed there is nothing left to do. Entries
 * the owner already has (same provider id) are kept as the owner saved them;
 * the legacy keys for that id are appended if they are not present yet.
 */

import fs from "node:fs";
import { loadProvidersFile, ConfigValidationError } from "./config-file";
import { getLegacyProvidersFilePath, readConfiguredProviders, writeConfiguredProviders, type DataDirOptions } from "./store";
import type { ProviderConfig } from "./types";
import { localUserExists, localUserIdForEmail, normalizeEmail } from "../users";

export const DEFAULT_OWNER_EMAIL = "james@swarmagents.codes";

export type MigrationResult =
  | { status: "no-legacy-file"; file: string }
  | { status: "owner-missing"; file: string; ownerEmail: string }
  | { status: "invalid-file"; file: string; error: string }
  | {
      status: "migrated";
      file: string;
      migratedTo: string;
      ownerEmail: string;
      ownerId: string;
      providers: string[];
      merged: string[];
    };

export interface MigrateOptions extends DataDirOptions {
  ownerEmail?: string;
  /** Skip the "owner has an account" check (tests / an explicit operator run). */
  force?: boolean;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function migrateLegacyProviders(options: MigrateOptions = {}): MigrationResult {
  const env = options.env ?? process.env;
  const file = getLegacyProvidersFilePath({ env });
  if (!fs.existsSync(file)) return { status: "no-legacy-file", file };

  const ownerEmail = normalizeEmail(options.ownerEmail ?? env.SWARM_OWNER_EMAIL ?? DEFAULT_OWNER_EMAIL);
  if (!ownerEmail) return { status: "owner-missing", file, ownerEmail: String(options.ownerEmail ?? env.SWARM_OWNER_EMAIL ?? "") };
  if (!options.force && !localUserExists(ownerEmail)) {
    return { status: "owner-missing", file, ownerEmail };
  }
  const ownerId = localUserIdForEmail(ownerEmail);

  let legacy: ProviderConfig[];
  try {
    legacy = loadProvidersFile(file);
  } catch (err) {
    const error = err instanceof ConfigValidationError || err instanceof Error ? err.message : String(err);
    return { status: "invalid-file", file, error };
  }

  const current = readConfiguredProviders(ownerId, { env });
  const byId = new Map(current.map((c) => [c.id, c]));
  const merged: string[] = [];
  for (const entry of legacy) {
    const existing = byId.get(entry.id);
    if (!existing) {
      // envKeys pointed at host env vars; a per-user provider carries its own keys.
      const { envKeys: _envKeys, ...rest } = entry;
      void _envKeys;
      byId.set(entry.id, { ...rest, keys: uniq(entry.keys ?? []) });
      continue;
    }
    merged.push(entry.id);
    byId.set(entry.id, { ...existing, keys: uniq([...(existing.keys ?? []), ...(entry.keys ?? [])]) });
  }
  // Keep the owner's own order, then any new legacy entries in file order.
  const order = uniq([...current.map((c) => c.id), ...legacy.map((c) => c.id)]);
  const next = order.map((id) => byId.get(id)).filter((c): c is ProviderConfig => Boolean(c));
  writeConfiguredProviders(ownerId, next, { env });

  const migratedTo = `${file}.migrated`;
  fs.renameSync(file, migratedTo);
  try {
    fs.chmodSync(migratedTo, 0o600);
  } catch {
    // Best effort.
  }
  return {
    status: "migrated",
    file,
    migratedTo,
    ownerEmail,
    ownerId,
    providers: legacy.map((c) => c.id),
    merged,
  };
}

/** Run the migration at startup; never throws, logs the outcome (no key material). */
export function migrateLegacyProvidersAtStartup(): MigrationResult | null {
  try {
    const result = migrateLegacyProviders();
    switch (result.status) {
      case "migrated":
        console.log(
          `[swarm-providers] moved ${result.providers.length} provider(s) from ${result.file} into ${result.ownerEmail}'s account; ` +
            `the old file is now ${result.migratedTo} (it still holds plaintext keys: shred it once you have checked the account).`
        );
        break;
      case "owner-missing":
        console.warn(
          `[swarm-providers] legacy ${result.file} not migrated: owner account ${result.ownerEmail || "(SWARM_OWNER_EMAIL invalid)"} ` +
            `does not exist yet. The file is not used by any route; create the account and restart (or run scripts/migrate-providers.ts).`
        );
        break;
      case "invalid-file":
        console.error(`[swarm-providers] legacy ${result.file} not migrated: ${result.error}`);
        break;
      case "no-legacy-file":
        break;
    }
    return result;
  } catch (err) {
    console.error(`[swarm-providers] provider migration failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
