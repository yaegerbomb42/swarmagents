/**
 * Server-side URL validation for user-supplied provider endpoints.
 *
 * The shared server must never be turned into an SSRF proxy: a custom base URL
 * may only reach public https hosts. Loopback and private ranges are allowed
 * only in local (single-user) mode, or for hosts an operator explicitly
 * allowlists as the user's BYOC / local runtime gateway
 * (`SWARM_PROVIDER_PRIVATE_HOSTS`, comma-separated hosts or `*.suffix`).
 *
 * Cloud metadata addresses are always rejected, even in local mode.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface UrlSafetyOptions {
  /**
   * True on the shared, multi-tenant server. Defaults to SWARM_SERVER_MODE.
   * On a shared server private addresses require an explicit allowlist.
   */
  serverMode?: boolean;
  /** Extra hosts/CIDR-ish literals allowed to be private (BYOC gateways). */
  allowHosts?: readonly string[];
}

export type UrlSafetyResult =
  | { ok: true; url: URL }
  | { ok: false; error: string };

const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);
const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254",
  "fd00:ec2::254",
]);

function envServerMode(): boolean {
  const v = process.env.SWARM_SERVER_MODE;
  return v === "1" || v === "true" || v === "yes";
}

function envAllowHosts(): string[] {
  return (process.env.SWARM_PROVIDER_PRIVATE_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // URL keeps a trailing dot on FQDNs; strip it for matching.
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function ipv4Parts(host: string): number[] | null {
  if (isIP(host) !== 4) return null;
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

/** True for loopback, RFC1918, link-local, CGNAT and IPv6 equivalents. */
export function isPrivateHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "") return true;
  if (LOOPBACK_NAMES.has(host)) return true;

  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  if (isIP(host) === 6) {
    if (host === "::" || host === "::1") return true;
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // ULA
    if (host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) {
      return true; // link-local fe80::/10
    }
    if (host.startsWith("::ffff:")) return isPrivateHostname(host.slice("::ffff:".length));
    return false;
  }

  // Single-label names resolve through the local resolver (docker compose
  // service names, LAN hosts). Treat them as private.
  if (!host.includes(".")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return true;
  return false;
}

function isMetadataHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return METADATA_HOSTS.has(host) || host.endsWith(".metadata.google.internal");
}

function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = normalizeHost(host);
  for (const raw of allowHosts) {
    const allowed = normalizeHost(raw);
    if (!allowed) continue;
    if (allowed === h) return true;
    if (allowed.startsWith("*.") && h.endsWith(allowed.slice(1))) return true;
    if (allowed.startsWith(".") && h.endsWith(allowed)) return true;
  }
  return false;
}

/**
 * Validate a provider base URL. Returns the parsed URL on success.
 * `allowPrivate` is intentionally not a direct knob: callers choose the
 * deployment mode and (optionally) an allowlist.
 */
export function validateProviderBaseUrl(
  value: string,
  options: UrlSafetyOptions = {},
): UrlSafetyResult {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return { ok: false, error: "Base URL is required." };
  if (trimmed.length > 2_048) return { ok: false, error: "Base URL is too long." };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Base URL is not a valid URL." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Base URL must not contain credentials; save the key separately." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Base URL must use https (http only for local/BYOC hosts)." };
  }

  const host = normalizeHost(url.hostname);
  if (isMetadataHost(host)) {
    return { ok: false, error: "Cloud metadata hosts are not allowed." };
  }

  const serverMode = options.serverMode ?? envServerMode();
  const allowHosts = [...envAllowHosts(), ...(options.allowHosts ?? [])];
  const privateHost = isPrivateHostname(host);
  const explicitlyAllowed = hostAllowed(host, allowHosts);

  if (privateHost && serverMode && !explicitlyAllowed) {
    return {
      ok: false,
      error:
        "Private/loopback addresses are not allowed on the shared server. Use an allowlisted BYOC gateway URL.",
    };
  }
  if (privateHost && !serverMode && url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Base URL must use http(s)." };
  }
  if (!privateHost && url.protocol !== "https:" && !explicitlyAllowed) {
    return { ok: false, error: "Public endpoints must use https." };
  }
  return { ok: true, url };
}

/**
 * Validate a URL and (in server mode, outside the allowlist) resolve its host
 * so a public-looking name cannot point at an internal address (DNS rebinding
 * at request time still exists, but the obvious case is caught here).
 */
export async function assertResolvableProviderBaseUrl(
  value: string,
  options: UrlSafetyOptions = {},
): Promise<UrlSafetyResult> {
  const result = validateProviderBaseUrl(value, options);
  if (!result.ok) return result;

  const serverMode = options.serverMode ?? envServerMode();
  const host = normalizeHost(result.url.hostname);
  const allowHosts = [...envAllowHosts(), ...(options.allowHosts ?? [])];
  if (!serverMode || hostAllowed(host, allowHosts) || isIP(host) !== 0) return result;

  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return { ok: false, error: "Base URL host did not resolve." };
    for (const entry of addresses) {
      if (isPrivateHostname(entry.address)) {
        return { ok: false, error: "Base URL resolves to a private address, which is not allowed." };
      }
    }
  } catch {
    return { ok: false, error: "Base URL host did not resolve." };
  }
  return result;
}
