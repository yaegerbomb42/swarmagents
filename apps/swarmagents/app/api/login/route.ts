/**
 * POST /api/login
 *
 * Sign a local password user in (lib/users store) and mint the session
 * cookie (HttpOnly, Secure, SameSite=Lax — see lib/auth sessionCookieOptions).
 *
 * Responses never reveal whether an email exists (the same 401 covers an
 * unknown user and a wrong password). Login attempts are rate-limited by
 * middleware, and the route additionally enforces per-email and per-IP
 * failed-login budgets (lib/rate-limit) before any credential check runs,
 * so a slow brute-force attack against one account cannot burn scrypt work.
 * The route also honors a validated same-origin `next` param
 * so the client can send the user back where they were headed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { jsonErrorWithRequestId } from "../../../lib/request-id";
import { safeNextPath, sessionCookieOptions, signSession, SESSION_COOKIE } from "../../../lib/auth";
import {
  verifyLocalUser,
  isScryptBusyError,
  normalizeEmail,
  localUserIdForEmail,
  type LocalUser,
} from "../../../lib/users";
import { recordAudit, auditLoginFailureTarget } from "../../../lib/audit";
import { JsonBodyError, readJsonBody } from "../../../lib/http";
import {
  clientIp,
  checkLoginRateLimit,
  refundLoginRateLimit,
  UNIDENTIFIED_KEY,
} from "../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sign-in responses carry (or refuse) a session cookie: never cache them. */
const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(req: NextRequest): Promise<Response> {
  if (!process.env.SWARM_SESSION_SECRET) {
    return jsonErrorWithRequestId(
      req,
      { error: "Server is not configured for sessions." },
      { status: 500, headers: NO_STORE },
    );
  }

  // Bounded, streaming body read: an oversized body is rejected with 413
  // before it is buffered; anything else unparseable stays a 400, as before.
  let body: Record<string, unknown>;
  try {
    const value = await readJsonBody(req, MAX_BODY_SIZE);
    if (!isRecord(value)) {
      return jsonErrorWithRequestId(req, { error: "Invalid request body." }, { status: 400, headers: NO_STORE });
    }
    body = value;
  } catch (err) {
    if (err instanceof JsonBodyError && err.status === 413) {
      return jsonErrorWithRequestId(req, { error: "Request body too large." }, { status: 413, headers: NO_STORE });
    }
    return jsonErrorWithRequestId(req, { error: "Invalid request body." }, { status: 400, headers: NO_STORE });
  }

  // Per-account and per-IP failed-login budgets, enforced before any
  // credential check so a brute-force run cannot burn scrypt work. The
  // email key uses the same normalization as verifyLocalUser, so case
  // variants of one address share one bucket. A token is taken from each
  // bucket up front and handed back unless the credentials were actually
  // wrong, so successful logins never consume the failure budget.
  const emailKey = normalizeEmail(body.email) || null;
  const ip = clientIp(req);
  const ipKey = ip ? `ip:${ip}` : UNIDENTIFIED_KEY;
  const rate = checkLoginRateLimit(emailKey, ipKey);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again later." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(rate.retryAfter) } },
    );
  }

  let user: LocalUser | null = null;
  try {
    user = await verifyLocalUser(body.email, body.password);
  } catch (err) {
    // A scrypt-busy shed or an unexpected error is not a failed credential
    // check: hand the tokens back so server load cannot lock a user out.
    refundLoginRateLimit(emailKey, ipKey);
    if (isScryptBusyError(err)) {
      // The global scrypt concurrency cap and its wait queue are saturated.
      return NextResponse.json(
        { error: "Too many sign-in attempts right now. Try again shortly." },
        { status: 429, headers: { ...NO_STORE, "Retry-After": "1" } },
      );
    }
    throw err;
  }
  if (!user) {
    // The attempted email is an identifier, not a secret; the password is
    // never logged. Attribute the failure to the TARGETED account (its uid)
    // so brute-force attempts show up in that user's own audit log — not
    // under a global "anonymous" that nobody can see. Sanitize before audit
    // so targets stay bounded and printable. The same generic 401 is
    // returned either way, so attributing the audit line reveals nothing
    // about whether the account actually exists.
    const normalized = normalizeEmail(body.email);
    const attemptedUid = normalized ? localUserIdForEmail(normalized) : "anonymous";
    recordAudit({
      user: attemptedUid,
      action: "login.failure",
      target: auditLoginFailureTarget(body.email),
      result: "failure",
    });
    return jsonErrorWithRequestId(req, { error: "Invalid credentials." }, { status: 401, headers: NO_STORE });
  }

  refundLoginRateLimit(emailKey, ipKey);
  recordAudit({ user: user.uid, action: "login.success", target: user.uid, result: "success" });
  const res = NextResponse.json(
    { ok: true, user: { id: user.uid }, next: safeNextPath(body.next) },
    { headers: NO_STORE },
  );
  res.cookies.set(SESSION_COOKIE, signSession(user.uid), sessionCookieOptions());
  return res;
}
