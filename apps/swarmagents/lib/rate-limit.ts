import { type NextRequest, NextResponse } from "next/server";
import { type AuthUser } from "./auth";

const MAX_KEYS = 10_000;

function perMinute(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/** Full rate-limit decision for a request that hit the middleware. */
export interface RateInfo {
  allowed: boolean;
  /** Seconds until the key may retry (0 when allowed). */
  retryAfter: number;
  /** Bucket capacity (requests per window). */
  limit: number;
  /** Tokens remaining after this request. */
  remaining: number;
  /** Seconds until the bucket refills to capacity. */
  reset: number;
}

export class TokenBucket {
  private buckets = new Map<string, Bucket>();

  constructor(
    readonly capacity: number,
    private windowMs: number,
  ) {}

  /** Seconds until the bucket refills from `remaining` back to capacity. */
  private resetSeconds(remaining: number): number {
    return Math.ceil(((this.capacity - remaining) / this.capacity) * (this.windowMs / 1000));
  }

  consume(key: string, tokens = 1): Omit<RateInfo, "limit"> {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
    } else {
      const elapsed = now - bucket.lastRefill;
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + (elapsed / this.windowMs) * this.capacity,
      );
      bucket.lastRefill = now;
    }

    if (!this.buckets.has(key) && this.buckets.size >= MAX_KEYS) {
      // Bound memory: drop the oldest-inserted key (Map preserves insertion order).
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      const remaining = Math.floor(bucket.tokens);
      this.buckets.set(key, bucket);
      return { allowed: true, retryAfter: 0, remaining, reset: this.resetSeconds(remaining) };
    }

    const needed = tokens - bucket.tokens;
    const remaining = Math.floor(bucket.tokens);
    const retryAfterMs = Math.ceil((needed / this.capacity) * this.windowMs);
    this.buckets.set(key, bucket);
    return {
      allowed: false,
      retryAfter: Math.ceil(retryAfterMs / 1000),
      remaining,
      reset: this.resetSeconds(remaining),
    };
  }

  /**
   * Return tokens to a bucket (e.g. a login that turned out to be
   * legitimate). Applies the same time-based refill first, then adds the
   * tokens back, clamped at capacity. A no-op when the key has no bucket.
   */
  refund(key: string, tokens = 1): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (elapsed / this.windowMs) * this.capacity + tokens,
    );
    bucket.lastRefill = now;
    this.buckets.set(key, bucket);
  }

  /** Internal: clear all buckets. */
  _clear(): void {
    this.buckets.clear();
  }
}

/** General API bucket (SWARM_RATE_LIMIT_PER_MIN, default 300/min). */
const apiBucket = new TokenBucket(perMinute("SWARM_RATE_LIMIT_PER_MIN", 300), 60_000);

/** The public swarm board is polled by many workers that often share one egress IP. */
const boardBucket = new TokenBucket(perMinute("SWARM_BOARD_RATE_LIMIT_PER_MIN", 1200), 60_000);

/**
 * The in-VM PreToolUse approval hook calls this once per tool call; several
 * agents behind the same docker NAT / proxy egress IP can be chatty. Still
 * bounded and token-authenticated at the route, but roomier than the general
 * API budget.
 */
const approvalBucket = new TokenBucket(
  perMinute("SWARM_APPROVAL_RATE_LIMIT_PER_MIN", 1200),
  60_000,
);

/**
 * Public share pages (/share/<token>). The page is unauthenticated, so it is
 * throttled per IP: a scanner minting random tokens must not be able to turn
 * one request into a full sweep of the box (bug 19).
 */
const shareBucket = new TokenBucket(perMinute("SWARM_SHARE_RATE_LIMIT_PER_MIN", 60), 60_000);

/** Never throttled: liveness probes. */
const EXEMPT = new Set(["/api/health"]);

/** Stricter login bucket: 5 requests per minute. */
const loginBucket = new TokenBucket(5, 60_000);

/** Window for the failed-login budgets below (15 minutes). */
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;

function perCount(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Failed-login budget per account (SWARM_LOGIN_EMAIL_LIMIT, default 10 per 15 min). */
export const LOGIN_EMAIL_LIMIT = perCount("SWARM_LOGIN_EMAIL_LIMIT", 10);
/** Failed-login budget per client IP (SWARM_LOGIN_IP_LIMIT, default 30 per 15 min). */
export const LOGIN_IP_LIMIT = perCount("SWARM_LOGIN_IP_LIMIT", 30);

/**
 * Failed-login budgets for POST /api/login. Unlike the middleware's
 * per-minute login bucket (which counts every request), these count only
 * failed credential checks: a token is taken before verifyLocalUser runs
 * and handed back when the login succeeds, so legitimate sign-ins never
 * consume the failure budget.
 */
const loginEmailBucket = new TokenBucket(LOGIN_EMAIL_LIMIT, LOGIN_FAILURE_WINDOW_MS);
const loginIpBucket = new TokenBucket(LOGIN_IP_LIMIT, LOGIN_FAILURE_WINDOW_MS);

/** Decision from the failed-login buckets. */
export interface LoginRateLimit {
  allowed: boolean;
  /** Seconds until the tripped bucket admits another attempt (0 when allowed). */
  retryAfter: number;
}

/**
 * Take one token from the per-email bucket (when an email key is given) and
 * one from the per-IP bucket. When the IP bucket denies, the email token is
 * handed back so a denied attempt cannot drain the account budget.
 */
export function checkLoginRateLimit(
  emailKey: string | null,
  ipKey: string,
): LoginRateLimit {
  if (emailKey) {
    const email = loginEmailBucket.consume(emailKey);
    if (!email.allowed) return { allowed: false, retryAfter: email.retryAfter };
    const ip = loginIpBucket.consume(ipKey);
    if (!ip.allowed) {
      loginEmailBucket.refund(emailKey);
      return { allowed: false, retryAfter: ip.retryAfter };
    }
    return { allowed: true, retryAfter: 0 };
  }
  const ip = loginIpBucket.consume(ipKey);
  return { allowed: ip.allowed, retryAfter: ip.retryAfter };
}

/** Hand back the tokens taken by checkLoginRateLimit (successful login, or an attempt that never ran as a credential check). */
export function refundLoginRateLimit(emailKey: string | null, ipKey: string): void {
  if (emailKey) loginEmailBucket.refund(emailKey);
  loginIpBucket.refund(ipKey);
}

/**
 * Provider completion bucket: one completion can fan out to 8 upstream LLM
 * calls, so it gets its own per-user budget (tighter than the general API
 * 300/min) rather than sharing the app-wide bucket. 60/min by default,
 * tunable with SWARM_COMPLETE_RATE_LIMIT_PER_MIN.
 */
const completeBucket = new TokenBucket(perMinute("SWARM_COMPLETE_RATE_LIMIT_PER_MIN", 60), 60_000);

/**
 * Provider health-probe bucket: a probe is a live outbound call per click.
 * 30/min per user by default, tunable with
 * SWARM_PROVIDER_PROBE_RATE_LIMIT_PER_MIN.
 */
const probeBucket = new TokenBucket(perMinute("SWARM_PROVIDER_PROBE_RATE_LIMIT_PER_MIN", 30), 60_000);

/**
 * Signup bucket: account creation is also scrypt-heavy, so it gets its own
 * strict per-identity budget rather than sharing the app-wide 300/min bucket.
 * 5/min by default, tunable with SWARM_SIGNUP_RATE_LIMIT_PER_MIN.
 */
const signupBucket = new TokenBucket(perMinute("SWARM_SIGNUP_RATE_LIMIT_PER_MIN", 5), 60_000);

/**
 * Password-reset bucket (FIX-39): the request endpoint mints tokens and
 * sends mail, the confirm endpoint burns a scrypt hash — both get the
 * same strict per-identity budget as login/signup. 5/min by default,
 * tunable with SWARM_PASSWORD_RESET_RATE_LIMIT_PER_MIN.
 */
const passwordResetBucket = new TokenBucket(
  perMinute("SWARM_PASSWORD_RESET_RATE_LIMIT_PER_MIN", 5),
  60_000,
);

/**
 * Strict degraded-mode bucket for anonymous requests whose client identity
 * could not be established. It is deliberately separate from `apiBucket` so a
 * flood of unidentified traffic can never eat the app-wide 300/min budget,
 * and deliberately low so the fallback still throttles.
 */
const unidentifiedBucket = new TokenBucket(
  perMinute("SWARM_RATE_LIMIT_UNIDENTIFIED_PER_MIN", 10),
  60_000,
);

/** Rate-limit key used when no client identity could be established. */
export const UNIDENTIFIED_KEY = "anon:unidentified";

let warnedNoIdentity = false;

export function trustProxy(): boolean {
  const v = process.env.SWARM_TRUST_PROXY;
  return v === "1" || v === "true" || v === "yes";
}

export function trustedProxyHops(): number {
  const n = Number(process.env.SWARM_TRUSTED_PROXY_HOPS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Longest textual IP literal (RFC 4291 address with an embedded IPv4). */
const MAX_IP_LENGTH = 45;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Accept only plausible IP literals. A proxy that reports a placeholder
 * ("unknown", "-") must not collapse every client onto a single shared key —
 * that is the bug this module exists to prevent.
 */
export function isIpAddress(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v.length > MAX_IP_LENGTH) return false;
  if (IPV4_RE.test(v)) return v.split(".").every((o) => Number(o) <= 255);
  // IPv6 (including IPv4-mapped "::ffff:203.0.113.7"): hex digits, colons, dots.
  return v.includes(":") && /^[0-9A-Fa-f:.]+$/.test(v);
}

/** Trimmed IP literal, or null when the value is not a usable address. */
function normalizeIp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return isIpAddress(v) ? v : null;
}

function warnNoIdentityOnce(): void {
  if (warnedNoIdentity) return;
  warnedNoIdentity = true;
  console.warn(
    "[rate-limit] WARNING: no client identity could be established for anonymous requests; " +
      "falling back to strict mode (anonymous traffic shares one limited bucket). " +
      "Set SWARM_TRUST_PROXY=1 with SWARM_TRUSTED_PROXY_HOPS and make the reverse proxy set " +
      "X-Real-IP / X-Forwarded-For from the peer address so each client gets its own bucket.",
  );
}

/**
 * Identity of the client as seen by the reverse proxy. Only usable when the
 * proxy overwrites the header (nginx `proxy_set_header X-Real-IP $remote_addr`),
 * never when the header comes straight from the client.
 */
function peerIp(req: NextRequest): string | null {
  const realIp = normalizeIp(req.headers.get("x-real-ip"));
  if (realIp) return realIp;
  // `req.ip` only exists on platforms that populate it (not self-hosted Next 15).
  const ip = (req as unknown as { ip?: string }).ip;
  return normalizeIp(typeof ip === "string" ? ip : null);
}

/**
 * Client address for anonymous requests.
 *
 * - `SWARM_TRUST_PROXY` on: read `X-Forwarded-For` and take the entry that is
 *   `SWARM_TRUSTED_PROXY_HOPS` trusted hops from the right, so a client cannot
 *   spoof its address by prepending entries. Fall back to `X-Real-IP`.
 * - `SWARM_TRUST_PROXY` off: ignore client-supplied `X-Forwarded-For` entirely
 *   and use the peer address (`X-Real-IP` set by our proxy, or `req.ip`).
 *
 * Returns null when no identity can be established.
 */
export function clientIp(req: NextRequest): string | null {
  if (trustProxy()) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      // Keep the raw positions: the hop count is measured from the right, so a
      // client that prepends entries cannot shift the address we pick.
      const parts = forwarded
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        const hops = trustedProxyHops();
        const idx = Math.max(0, parts.length - 1 - hops);
        const picked = normalizeIp(parts[idx]);
        if (picked) return picked;
      }
    }
    const realIp = normalizeIp(req.headers.get("x-real-ip"));
    if (realIp) return realIp;
    return null;
  }

  return peerIp(req);
}

export function rateLimitKey(req: NextRequest, user: AuthUser | null): string {
  if (user) return `user:${user.id}`;
  const ip = clientIp(req);
  if (ip) return `ip:${ip}`;
  warnNoIdentityOnce();
  // No fingerprinting: fall back to strict mode (its own bucket), never silently
  // onto the shared app-wide API budget.
  return UNIDENTIFIED_KEY;
}

/**
 * Key for the public share pages: always per IP, even when the visitor
 * happens to be signed in (the share link itself is the credential).
 */
export function shareRateLimitKey(req: NextRequest): string {
  const ip = clientIp(req);
  if (ip) return `ip:${ip}`;
  warnNoIdentityOnce();
  return UNIDENTIFIED_KEY;
}

export function rateLimitCheck(
  pathname: string,
  key: string,
): RateInfo | null {
  const isShare = pathname.startsWith("/share/") || pathname.startsWith("/preview/share/");
  if (!pathname.startsWith("/api/") && !isShare) return null;
  if (EXEMPT.has(pathname)) return null;

  let bucket: TokenBucket;
  if (pathname === "/api/mcp/swarm-board") bucket = boardBucket;
  else if (pathname === "/api/runtime/approvals/hook") bucket = approvalBucket;
  // Unidentified anonymous traffic never touches the shared app-wide budget and
  // never the shared login bucket: it gets its own strict bucket instead.
  else if (key === UNIDENTIFIED_KEY) bucket = unidentifiedBucket;
  else if (pathname === "/api/login") bucket = loginBucket;
  else if (pathname === "/api/signup") bucket = signupBucket;
  else if (pathname.startsWith("/api/password-reset/") || pathname.startsWith("/api/email-verification/"))
    bucket = passwordResetBucket;
  else if (isShare) bucket = shareBucket;
  else bucket = apiBucket;

  const r = bucket.consume(key);
  return {
    allowed: r.allowed,
    retryAfter: r.retryAfter,
    limit: bucket.capacity,
    remaining: r.remaining,
    reset: r.reset,
  };
}

export function rateLimitResponse(rate: RateInfo): NextResponse {
  const res = new NextResponse("Too Many Requests", { status: 429 });
  res.headers.set("Retry-After", String(rate.retryAfter));
  res.headers.set("X-RateLimit-Limit", String(rate.limit));
  res.headers.set("X-RateLimit-Remaining", String(rate.remaining));
  res.headers.set("X-RateLimit-Reset", String(rate.reset));
  return res;
}

/** Reset all singleton buckets (for tests). */
export function resetBuckets(): void {
  apiBucket._clear();
  loginBucket._clear();
  loginEmailBucket._clear();
  loginIpBucket._clear();
  signupBucket._clear();
  passwordResetBucket._clear();
  boardBucket._clear();
  approvalBucket._clear();
  unidentifiedBucket._clear();
  shareBucket._clear();
  completeBucket._clear();
  probeBucket._clear();
}

/**
 * Per-user completion budget for POST /api/providers/complete. Returns
 * whether the call may proceed and, when denied, how many seconds to wait.
 * The key is the signed-in user id; callers check auth before calling this.
 */
export function checkCompleteRateLimit(user: string): { allowed: boolean; retryAfter: number } {
  const r = completeBucket.consume(`user:${user}`);
  return { allowed: r.allowed, retryAfter: r.retryAfter };
}

/**
 * Per-user health-probe budget for POST /api/providers/[id]/test. Same
 * shape as checkCompleteRateLimit; a separate bucket so probe clicks can
 * never eat the completion budget or vice versa.
 */
export function checkProviderProbeRateLimit(user: string): { allowed: boolean; retryAfter: number } {
  const r = probeBucket.consume(`user:${user}`);
  return { allowed: r.allowed, retryAfter: r.retryAfter };
}

/** Reset one-time warning state (for tests). */
export function resetRateLimitWarnings(): void {
  warnedNoIdentity = false;
}
