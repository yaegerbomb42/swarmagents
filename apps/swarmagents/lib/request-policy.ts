import type { NextRequest } from "next/server";
import { trustProxy } from "./rate-limit";

/**
 * Configured public hostnames (SWARM_ALLOWED_HOSTS, port stripped, lowercase).
 * Empty when unset — callers must not treat that as "any host is allowed".
 */
function allowedHosts(): string[] {
  return (process.env.SWARM_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().split(":")[0])
    .filter(Boolean);
}

/** Hostname of a Host-style value ("example.com:3777" -> "example.com"). */
function hostnameOf(hostValue: string): string | null {
  try {
    return new URL(`http://${hostValue}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** First value of a comma-chained header, trimmed ("" when absent/empty). */
function firstHeaderValue(req: NextRequest, name: string): string {
  return req.headers.get(name)?.split(",")[0]?.trim() ?? "";
}

/**
 * Scheme the client used to reach the proxy, from `x-forwarded-proto`.
 * Only ever consulted when proxy trust is on. Anything other than a bare
 * http/https first value falls back to the internal scheme, so a malformed
 * or spoofed value can never widen what counts as same-origin.
 */
function forwardedProtocol(req: NextRequest): string {
  const proto = firstHeaderValue(req, "x-forwarded-proto").toLowerCase();
  return proto === "http" || proto === "https" ? proto : req.nextUrl.protocol.replace(":", "");
}

/**
 * True when browser metadata proves a request came from another origin.
 * Missing headers are allowed for non-browser API clients. The complete
 * normalized origin is compared, including scheme and effective port.
 *
 * Forwarded headers are untrusted by default: `x-forwarded-host` and
 * `x-forwarded-proto` are ignored unless the operator explicitly enabled
 * proxy trust (SWARM_TRUST_PROXY=1 — the proxy is then expected to set
 * them, and a client-supplied value cannot reach the app). When trust is
 * on, a forwarded host outside SWARM_ALLOWED_HOSTS is never allowed to
 * define the expected origin — such a request is cross-site. When the
 * allowlist is unset, a trusted proxy's forwarded host is taken at face
 * value (there is nothing to check it against); in server mode the host
 * gate in lib/auth.ts denies requests outright when the allowlist is
 * unset, so this case only arises in local mode.
 *
 * When trust is on but the proxy sent no `x-forwarded-host` (the shipped
 * nginx sets Host + X-Forwarded-Proto only), the Host header still names
 * the public host — it is already gated by hostAllowed() in middleware —
 * but the internal URL carries the proxy-to-app scheme (http), so the
 * expected origin's scheme comes from `x-forwarded-proto`. Without this,
 * every same-site POST behind a TLS terminator compares an https Origin
 * against an http expected origin and 403s (login included).
 */
export function isCrossSite(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      let host: string;
      let protocol: string;
      if (trustProxy()) {
        const forwardedHost = firstHeaderValue(req, "x-forwarded-host");
        if (forwardedHost) {
          const forwardedHostname = hostnameOf(forwardedHost);
          const allowed = allowedHosts();
          if (forwardedHostname && allowed.length > 0 && !allowed.includes(forwardedHostname)) {
            return true;
          }
          host = forwardedHost;
          protocol = forwardedProtocol(req);
        } else {
          // No forwarded host: the Host header names the public host (the
          // shipped nginx sets it from $host), but the scheme the client
          // used is only in x-forwarded-proto — the internal URL is http.
          host = req.headers.get("host") || req.nextUrl.host;
          protocol = forwardedProtocol(req);
        }
      } else {
        // Proxy trust off: forwarded headers are client-controlled input and
        // are ignored entirely — the direct Host header defines the origin.
        host = req.headers.get("host") || req.nextUrl.host;
        protocol = req.nextUrl.protocol.replace(":", "");
      }
      const expectedOrigin = new URL(`${protocol}://${host}`).origin;
      if (new URL(origin).origin !== expectedOrigin) return true;
    } catch {
      return true;
    }
  }
  return req.headers.get("sec-fetch-site") === "cross-site";
}
