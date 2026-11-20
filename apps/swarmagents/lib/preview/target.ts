/**
 * Resolve a preview target for (userId, port) — the single choke point both
 * proxy entry points go through.
 *
 * Order matters for security and for hibernation:
 *   1. The port must be syntactically valid and not infrastructure.
 *   2. The port must be in the user's *detected listening set* (fresh probe
 *      or warm TTL cache). A port that is not listening is never dialed —
 *      this is what makes arbitrary-port SSRF impossible: the client can
 *      name any port, but only a port a process in their own VM is actually
 *      listening on resolves.
 *   3. Only then is the VM container IP resolved (vmHost). This runs after
 *      the port check so a probe for a bogus port never wakes or touches a
 *      VM, and so a hibernated VM (empty detected set) fails closed.
 *
 * The host always comes from the driver (docker inspect), never from the
 * client; the port always comes from the detected set, never from the
 * client alone. A preview URL for one user's VM can therefore never serve
 * another user's VM: the host is resolved from the authenticated caller's
 * own handle, under the driver's owner-label check.
 */

import type { VmManager } from "../vm/manager";
import { isPreviewablePort, PREVIEW_EXCLUDED_PORTS, type ListeningPortsOptions } from "./ports";
import type { PreviewTarget } from "./proxy";

/** Parse a route port segment; null when it is not a plain port number. */
export function parsePreviewPort(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return null;
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) return null;
  if (PREVIEW_EXCLUDED_PORTS.has(port)) return null;
  return port;
}

/**
 * Resolve the dial target for a user's preview port, or null when the port
 * is not previewable for them right now (not listening, VM not running, or
 * no container network). Null is a 404/502 at the route, never a dial.
 */
export async function resolvePreviewTarget(
  manager: VmManager,
  userId: string,
  port: number,
  opts: ListeningPortsOptions = {},
): Promise<PreviewTarget | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (PREVIEW_EXCLUDED_PORTS.has(port)) return null;
  if (!(await isPreviewablePort(manager, userId, port, opts))) return null;
  const host = await manager.vmHost(userId);
  if (!host) return null;
  return { host, port };
}
