/**
 * Per-user custom role store.
 *
 * Custom roles belong to the signed-in user and live on the server, in
 * `<data dir>/users/<hash(userId)>/roles.json` (dir mode 700, file mode 600) —
 * the same layout the per-user provider store uses, so one data dir serves
 * both. There is intentionally no server-wide role file: an account's roles
 * are its own.
 *
 * The file holds a role bundle (same schema as the export/import format in
 * lib/roles.ts, plus the owner id), so it can be parsed with the shared
 * parseRoleData()/normalizeRoleDefinition() code, including v1 -> v2
 * migration of roles saved by older versions of the app.
 */

import fs from "node:fs";
import path from "node:path";
import {
  BUILTIN_ROLE_IDS,
  ROLE_SCHEMA,
  ROLE_SCHEMA_VERSION,
  catalogForRoles,
  parseRoleData,
  normalizeRoleDefinition,
  type RoleDefinition,
} from "./roles";
import { resolveDataDir, userDirName, type DataDirOptions } from "./providers/store";
import { atomicWriteFile } from "./atomic-write";

/** Per-user roles file name inside the user's directory. */
export const USER_ROLES_FILE = "roles.json";
const MAX_USER_ID_LEN = 256;

function requireUserId(userId: string): string {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > MAX_USER_ID_LEN) {
    throw new Error("A signed-in user is required.");
  }
  return userId;
}

/** One user's custom roles file. */
export function userRolesFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(resolveDataDir(options), "users", userDirName(userId), USER_ROLES_FILE);
}

/**
 * Read a user's saved custom roles (normalized; built-in ids dropped).
 * A missing file returns []. A malformed file, or one that belongs to a
 * different user, returns [] and logs.
 */
export function readUserCustomRoles(userId: string, options: DataDirOptions = {}): RoleDefinition[] {
  const file = userRolesFilePath(userId, options);
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    console.error(`[swarm-roles] ignoring unreadable roles file ${file}: ${String(err)}`);
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`[swarm-roles] ignoring malformed roles file ${file}: ${String(err)}`);
    return [];
  }
  // Owner check: the file records who wrote it; a file from another user
  // (or a legacy server-wide bundle) is ignored.
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (typeof record.userId === "string" && record.userId !== userId) {
      console.error(`[swarm-roles] ignoring roles file ${file}: owner mismatch.`);
      return [];
    }
  }
  const parsed = parseRoleData(data);
  return parsed.roles;
}

/**
 * Atomically replace a user's custom roles file. Roles are normalized before
 * write; built-in ids are filtered out. Returns the written path.
 */
export function writeUserCustomRoles(
  userId: string,
  roles: readonly RoleDefinition[],
  options: DataDirOptions = {},
): string {
  requireUserId(userId);
  const file = userRolesFilePath(userId, options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: a read-only or foreign-owned mount keeps its mode.
  }
  const cleaned: RoleDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of roles) {
    const role = normalizeRoleDefinition(raw);
    if (!role || BUILTIN_ROLE_IDS.has(role.id) || seen.has(role.id)) continue;
    seen.add(role.id);
    cleaned.push(role);
  }
  const body = {
    schema: ROLE_SCHEMA,
    version: ROLE_SCHEMA_VERSION,
    userId,
    roles: cleaned,
  };
  atomicWriteFile(file, JSON.stringify(body, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
  return file;
}

/** The user's full role catalog: built-ins first, then their custom roles. */
export function userRoleCatalog(userId: string, options: DataDirOptions = {}): RoleDefinition[] {
  return catalogForRoles(readUserCustomRoles(userId, options));
}
