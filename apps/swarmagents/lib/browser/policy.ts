/**
 * URL policy for the agent browser.
 *
 * The browser is server-side headless Chromium; the agent (and UI) may ask it
 * to navigate anywhere, so every destination is vetted before `page.goto`.
 * This module is deliberately pure and side-effect free: same input, same
 * decision — no DNS, no network, no clock. It is trivially unit-testable and
 * safe to run before anything touches Chromium.
 *
 * Default posture: only `http:` / `https:` destinations are allowed, and
 * private / loopback / link-local address space is blocked (RFC 1918,
 * 0.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 100.64.0.0/10 CGNAT, IPv6
 * loopback `::1`, ULA `fc00::/7`, link-local `fe80::/10`, and IPv4-mapped
 * IPv6 forms). Hostnames `localhost` / `*.localhost` resolve into loopback
 * space and are blocked too.
 *
 * Hostnames that are not address literals are resolved when the browser
 * manager (`lib/browser/manager.ts`) vets a destination: every navigation —
 * and every request the page issues, subresources and redirect hops included
 * (via a Playwright route handler) — resolves the hostname with
 * `dns.lookup(all)` and is refused if any address is private / loopback /
 * link-local / CGNAT (or an IPv4-mapped IPv6 form thereof) before Chromium is
 * asked to load anything. The final post-navigation URL is re-checked against
 * this same policy, which catches redirects into `file://` or private
 * literals.
 */

import { promises as dns } from "node:dns";

/** Result of checking one destination. */
export type NavigationCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/** Parse and normalize a raw destination string; `null` when unparseable. */
export function parseNavigationUrl(raw: string): URL | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

/** IPv4 octets for a dotted-quad literal; `null` when not one. */
function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** True for RFC 1918 / special-purpose IPv4 space we never visit. */
function isPrivateIpv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC 1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918
  return false;
}

/** Expand an IPv6 literal to its eight 16-bit groups; null when invalid. */
function expandIpv6(host: string): number[] | null {
  let h = host.toLowerCase();
  // Allow a trailing dotted-quad (e.g. `::ffff:127.0.0.1`) by folding it into
  // two hex groups — an IPv4-mapped address uses two 16-bit groups for the
  // IPv4 octets (`::ffff:7f00:1`). URLs normalize this away, but raw DNS
  // lookup results may carry the dotted-quad form.
  const trailing4 = /^(.*):(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (trailing4) {
    const [a, b, c, d] = trailing4[2].split(".").map(Number);
    h = `${trailing4[1]}:${(((a << 8) | b).toString(16))}:${(((c << 8) | d).toString(16))}`;
  }
  if (!/^[0-9a-f:]+$/.test(h)) return null;

  let groups: number[];
  const doubleColon = h.indexOf("::");
  if (doubleColon !== -1) {
    const left = h.slice(0, doubleColon).split(":").filter(Boolean).map((g) => parseInt(g, 16));
    const right = h.slice(doubleColon + 2).split(":").filter(Boolean).map((g) => parseInt(g, 16));
    if (left.length + right.length >= 8) return null;
    groups = [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  } else {
    groups = h.split(":").map((g) => parseInt(g, 16));
    if (groups.length !== 8) return null;
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g))) return null;
  return groups;
}

/** True for IPv6 space we never visit. IPv4-mapped `::ffff:a.b.c.d` is decoded first. */
function isPrivateIpv6(host: string): boolean {
  const groups = expandIpv6(host);
  if (!groups) return false;

  // :: / ::1 — unspecified and loopback.
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;

  // fc00::/7 unique local, fe80::/10 link-local.
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  // IPv4-mapped IPv6 (::ffff:0:0/96): decode and apply the IPv4 rules.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const dotted = [
      (groups[6] >> 8) & 0xff,
      groups[6] & 0xff,
      (groups[7] >> 8) & 0xff,
      groups[7] & 0xff,
    ].join(".");
    return isPrivateIpv4(dotted);
  }
  return false;
}

/**
 * Strip the brackets the URL parser keeps around IPv6 literals
 * (`http://[::1]/` -> hostname `"[::1]"`).
 */
function bareIpv6(host: string): string {
  return host.length >= 2 && host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Is `host` an address literal we refuse to visit? */
export function isPrivateHost(host: string): boolean {
  if (!host) return false;
  if (host.includes(":")) return isPrivateIpv6(bareIpv6(host));
  return isPrivateIpv4(host);
}

/** Is `host` an IPv4/IPv6 literal (any address, private or not)? */
export function isAddressLiteral(host: string): boolean {
  if (!host) return false;
  if (host.includes(":")) {
    const lower = bareIpv6(host).toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return true;
    return /^[0-9a-f:]+$/.test(lower) && lower.includes(":");
  }
  return ipv4Octets(host) !== null;
}

/**
 * Canonicalize a hostname for policy checks: trim whitespace, lowercase,
 * strip trailing root dot(s) (`localhost.` -> `localhost`), and map
 * non-ASCII labels to their IDNA/punycode form so a literal and its
 * absolute-domain spelling are judged identically. Returns "" when nothing
 * remains after normalization.
 */
export function normalizeHostname(host: string): string {
  if (!host) return "";
  let h = host.trim().toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return "";
  try {
    const ascii = new URL(`http://${h}/`).hostname;
    if (ascii) h = ascii.toLowerCase();
  } catch {
    // Malformed for URL parsing; carry on with the trimmed lowercase form.
  }
  return h;
}

/** Hostname suffixes that resolve purely into reserved / private space. */
const PRIVATE_HOSTNAME_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal", ".localdomain"];

/**
 * True when `host` names special-use / reserved private address space by
 * construction — `localhost`, `*.localhost`, `*.local`, `*.internal`,
 * `*.localdomain`, and `metadata.google.internal`. These never depend on DNS:
 * a hostname carrying one of these suffixes (or the metadata name) always
 * targets private/metadata endpoints, so it is refused before any lookup.
 */
export function isPrivateHostname(host: string): boolean {
  const norm = normalizeHostname(host);
  if (!norm) return false;
  if (norm === "metadata.google.internal") return true;
  for (const suffix of PRIVATE_HOSTNAME_SUFFIXES) {
    if (norm === suffix.slice(1) || norm.endsWith(suffix)) return true;
  }
  return false;
}

/** Is `host` a hostname that resolves into loopback space (localhost.*)? */
export function isLoopbackHostname(host: string): boolean {
  const norm = normalizeHostname(host);
  return norm === "localhost" || norm.endsWith(".localhost");
}

/** True only for loopback, not for other private/link-local destinations. */
export function isLoopbackHost(host: string): boolean {
  if (isLoopbackHostname(host)) return true;
  if (host.includes(":")) {
    const groups = expandIpv6(bareIpv6(host));
    return groups !== null && groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  }
  return ipv4Octets(host)?.[0] === 127;
}

/**
 * Check a raw navigation target against the policy. `{ok:false}` reasons are
 * stable, human-readable strings surfaced to the UI and the agent.
 */
export function checkNavigation(raw: string): NavigationCheck {
  const url = parseNavigationUrl(raw);
  if (!url) return { ok: false, reason: "Malformed URL" };

  const scheme = url.protocol.replace(":", "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return { ok: false, reason: `Scheme "${scheme}" is not allowed (http/https only)` };
  }

  const host = url.hostname;
  if (!host) return { ok: false, reason: "URL has no host" };

  if (isPrivateHost(host)) {
    return { ok: false, reason: `Private address ${host} is blocked` };
  }
  if (isLoopbackHostname(host)) {
    return { ok: false, reason: `Loopback hostname ${host} is blocked` };
  }
  if (isPrivateHostname(host)) {
    return { ok: false, reason: `Private hostname ${host} is blocked` };
  }

  return { ok: true, url: url.toString() };
}

/** Convenience: assert and throw with the reason as message. */
export function assertSafeNavigation(raw: string): string {
  const check = checkNavigation(raw);
  if (!check.ok) throw new Error(check.reason);
  return check.url;
}

/** Resolve a hostname to all of its A/AAAA records (`[]` when unresolvable). */
export async function lookupAddresses(host: string): Promise<string[]> {
  try {
    const records = await dns.lookup(host, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

interface NavLookupCacheEntry {
  addresses: string[];
  at: number;
}

/** How long a DNS preflight result is trusted before a re-resolution. */
const NAV_LOOKUP_TTL_MS = 5_000;
/**
 * Hard cap on distinct hostnames retained. Expired rows are dropped first;
 * if the map is still full, the oldest insertion is evicted.
 */
const NAV_LOOKUP_MAX_ENTRIES = 256;
const navLookupCache = new Map<string, NavLookupCacheEntry>();

/** Clear the internal DNS-preflight cache (used by tests). */
export function clearNavLookupCache(): void {
  navLookupCache.clear();
}

/** Current DNS-preflight cache size (used by tests). */
export function navLookupCacheSize(): number {
  return navLookupCache.size;
}

function sweepExpiredNavLookups(now: number): void {
  for (const [key, entry] of navLookupCache) {
    if (now - entry.at >= NAV_LOOKUP_TTL_MS) navLookupCache.delete(key);
  }
}

function rememberNavLookup(key: string, addresses: string[], now: number): void {
  sweepExpiredNavLookups(now);
  // Re-insert so a refresh moves to the newest end of the Map.
  navLookupCache.delete(key);
  while (navLookupCache.size >= NAV_LOOKUP_MAX_ENTRIES) {
    const oldest = navLookupCache.keys().next().value;
    if (oldest === undefined) break;
    navLookupCache.delete(oldest);
  }
  navLookupCache.set(key, { addresses, at: now });
}

function cachedLookup(host: string, lookup: (h: string) => Promise<string[]>): Promise<string[]> {
  const key = normalizeHostname(host);
  const now = Date.now();
  const hit = navLookupCache.get(key);
  if (hit && now - hit.at < NAV_LOOKUP_TTL_MS) return Promise.resolve(hit.addresses);
  return lookup(key).then(
    (addresses) => {
      rememberNavLookup(key, addresses, now);
      return addresses;
    },
    () => [],
  );
}

/**
 * Async navigation check shared by BrowserManager and the desktop-MCP gate.
 * Runs the purely-syntactic `checkNavigation` first (scheme, private literals,
 * reserved hostnames), then adds the same DNS preflight BrowserManager uses:
 * every A/AAAA record for a non-literal hostname is resolved and the
 * navigation is refused if any lands in private / loopback / link-local /
 * CGNAT / metadata space (including IPv4-mapped IPv6 forms). A short TTL cache
 * narrows DNS rebinding windows between the preflight and the actual load.
 */
export async function checkNavigationAsync(
  raw: string,
  lookup: (host: string) => Promise<string[]> = lookupAddresses,
): Promise<NavigationCheck> {
  const check = checkNavigation(raw);
  if (!check.ok) return check;
  const url = parseNavigationUrl(raw)!;
  const host = url.hostname;
  // Address literals are fully covered by the syntactic check.
  if (isAddressLiteral(host)) return check;
  const addresses = await cachedLookup(host, lookup);
  const blocked = addresses.find((addr) => isPrivateHost(addr));
  if (blocked) return { ok: false, reason: `Destination resolves to private address ${blocked}` };
  return check;
}
