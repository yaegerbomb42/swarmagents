/**
 * POST /api/login
 *
 * Sign a local password user in (lib/users store) and mint the session
 * cookie (HttpOnly, Secure, SameSite=Lax — see lib/auth sessionCookieOptions).
 *
 * Responses never reveal whether an email exists (the same 401 covers an
 * unknown user and a wrong password). Login attempts are rate-limited by
 * middleware, and the route also honors a validated same-origin `next` param
 * so the client can send the user back where they were headed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath, sessionCookieOptions, signSession, SESSION_COOKIE } from "../../../lib/auth";
import { verifyLocalUser, isScryptBusyError, type LocalUser } from "../../../lib/users";
import { recordAudit, auditLoginFailureTarget } from "../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_SIZE) return null;
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** Sign-in responses carry (or refuse) a session cookie: never cache them. */
const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(req: NextRequest): Promise<Response> {
  if (!process.env.SWARM_SESSION_SECRET) {
    return NextResponse.json(
      { error: "Server is not configured for sessions." },
      { status: 500, headers: NO_STORE },
    );
  }

  const body = await readBody(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_STORE });
  }

  let user: LocalUser | null = null;
  try {
    user = await verifyLocalUser(body.email, body.password);
  } catch (err) {
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
    // never logged. Sanitize before audit so targets stay bounded and printable.
    recordAudit({
      user: "anonymous",
      action: "login.failure",
      target: auditLoginFailureTarget(body.email),
      result: "failure",
    });
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401, headers: NO_STORE });
  }

  recordAudit({ user: user.uid, action: "login.success", target: user.uid, result: "success" });
  const res = NextResponse.json(
    { ok: true, user: { id: user.uid }, next: safeNextPath(body.next) },
    { headers: NO_STORE },
  );
  res.cookies.set(SESSION_COOKIE, signSession(user.uid), sessionCookieOptions());
  return res;
}
