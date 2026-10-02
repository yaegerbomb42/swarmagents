import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF Protection for BYOK & Custom Endpoints.
 * Blocks requests to cloud metadata services, private networks, loopback (unless self-hosted opt-in),
 * link-local, multicast, and tailnet ranges.
 */

// Cloud metadata and special blacklisted IPs/ranges
const BLOCKED_EXACT_IPS = new Set([
  "169.254.169.254", // AWS/GCP/Azure/DigitalOcean metadata
  "169.254.170.2",   // AWS ECS task metadata
  "fd00:ec2::254",   // AWS IPv6 metadata
  "0.0.0.0",
  "::",
]);

export interface SsrfValidationOptions {
  allowLocalhost?: boolean;
}

export interface SsrfCheckResult {
  allowed: boolean;
  reason?: string;
  resolvedIp?: string;
}

/** Check if an IPv4 or IPv6 address is in a private, link-local, carrier-grade, or loopback range. */
export function isPrivateOrReservedIp(ip: string, allowLocalhost = false): boolean {
  if (BLOCKED_EXACT_IPS.has(ip)) return true;

  const version = net.isIP(ip);
  if (version === 0) return true; // Invalid IP

  if (version === 4) {
    const parts = ip.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return true;
    const [a, b, c, d] = parts;

    // 127.0.0.0/8 (Loopback)
    if (a === 127) {
      return !allowLocalhost;
    }

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;

    // 10.0.0.0/8 (Private)
    if (a === 10) return true;

    // 172.16.0.0/12 (Private)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return true;

    // 169.254.0.0/16 (Link-local / Cloud metadata)
    if (a === 169 && b === 254) return true;

    // 100.64.0.0/10 (Carrier-grade NAT / Tailscale 100.64.0.0 - 100.127.255.255)
    if (a === 100 && b >= 64 && b <= 127) return true;

    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (a === 192 && b === 0 && c === 0) return true;

    // 198.18.0.0/15 (Network benchmark tests)
    if (a === 198 && (b === 18 || b === 19)) return true;

    // 224.0.0.0/4 (Multicast)
    if (a >= 224 && a <= 239) return true;

    // 240.0.0.0/4 (Reserved / Future use)
    if (a >= 240) return true;

    // Broadcast
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;

    return false;
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    // Loopback ::1
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") {
      return !allowLocalhost;
    }

    // Unique local address fc00::/7 (fd00::/8)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

    // Link-local unicast fe80::/10
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;

    // IPv4-mapped IPv6 ::ffff:x.x.x.x
    if (lower.startsWith("::ffff:") || lower.startsWith("0:0:0:0:0:ffff:")) {
      const v4Part = lower.split(":").pop();
      if (v4Part && net.isIPv4(v4Part)) {
        return isPrivateOrReservedIp(v4Part, allowLocalhost);
      }
      return true;
    }

    // Multicast ff00::/8
    if (lower.startsWith("ff")) return true;

    return false;
  }

  return true;
}

/** Validate URL string against SSRF attack vectors. Resolves hostnames via DNS. */
export async function validateSsrfUrl(urlString: string, options: SsrfValidationOptions = {}): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: "Invalid URL format." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: "Only http and https protocols are supported." };
  }

  // Reject embedded credentials in authority (e.g. http://user:pass@host)
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: "URLs with embedded credentials are not allowed." };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Explicit localhost checks
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1") {
    if (!options.allowLocalhost) {
      return { allowed: false, reason: "Localhost endpoints are blocked in cloud mode. Enable self-hosted local access to connect." };
    }
  }

  // If hostname is already a raw IP
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname, options.allowLocalhost)) {
      return { allowed: false, reason: `Direct access to private or reserved IP (${hostname}) is blocked.` };
    }
    return { allowed: true, resolvedIp: hostname };
  }

  // Resolve hostname via DNS
  try {
    const lookup = await dns.lookup(hostname, { all: true });
    if (!lookup || lookup.length === 0) {
      return { allowed: false, reason: `Could not resolve hostname '${hostname}'.` };
    }

    for (const record of lookup) {
      if (isPrivateOrReservedIp(record.address, options.allowLocalhost)) {
        return {
          allowed: false,
          reason: `Hostname '${hostname}' resolves to private/blocked IP ${record.address}. Request blocked.`,
          resolvedIp: record.address,
        };
      }
    }

    return { allowed: true, resolvedIp: lookup[0].address };
  } catch (err) {
    return { allowed: false, reason: `DNS resolution failed for '${hostname}': ${(err as Error).message}` };
  }
}
