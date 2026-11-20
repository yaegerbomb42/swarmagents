/**
 * Admin identity for library moderation.
 *
 * There is no built-in "admin" account: the deployment names the people who
 * may review and unpublish public-library items with `SWARM_ADMIN_USERS`
 * (comma-separated user ids or account emails). Matching is case-insensitive;
 * a `local_<email>` session id also matches the bare email.
 *
 * In local (single-user) mode the machine's own `local` owner is an admin
 * unless `SWARM_ADMIN_USERS` is set explicitly — one person, one machine, no
 * shared catalog abuse to moderate.
 */

import { serverMode } from "../auth";

function adminEntries(env: Record<string, string | undefined> = process.env): string[] {
  return (env.SWARM_ADMIN_USERS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((entry) => {
      const values = [entry];
      if (entry.startsWith("local_")) values.push(entry.slice("local_".length));
      return values;
    });
}

function normalizedIds(userId: string): string[] {
  const id = userId.trim().toLowerCase();
  const values = [id];
  if (id.startsWith("local_")) values.push(id.slice("local_".length));
  return values;
}

/** True when `userId` may review or unpublish public items. */
export function isLibraryAdmin(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!userId) return false;
  const configured = env.SWARM_ADMIN_USERS?.trim();
  if (configured) {
    const admins = new Set(adminEntries(env));
    return normalizedIds(userId).some((id) => admins.has(id));
  }
  return !serverMode() && userId === "local";
}
