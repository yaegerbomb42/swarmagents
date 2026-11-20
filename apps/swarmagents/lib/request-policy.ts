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
 */
export function isCrossSite(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      let host: string;
      let protocol: string;
      if (trustProxy()) {
        const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
        if (forwardedHost) {
          const forwardedHostname = hostnameOf(forwardedHost);
          const allowed = allowedHosts();
          if (forwardedHostname && allowed.length > 0 && !allowed.includes(forwardedHostname)) {
            return true;
          }
          host = forwardedHost;
          const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
          protocol =
            forwardedProto === "http" || forwardedProto === "https"
              ? forwardedProto
              : req.nextUrl.protocol.replace(":", "");
        } else {
          host = req.headers.get("host") || req.nextUrl.host;
          protocol = req.nextUrl.protocol.replace(":", "");
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
