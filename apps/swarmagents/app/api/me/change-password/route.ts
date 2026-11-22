/**
 * POST /api/me/change-password
 *
 * Rotate the signed-in local account's password (FIX-40): verify the
 * current password, scrypt-hash the new one, and revoke every existing
 * session in the same write (lib/users setUserPassword, the primitive
 * shared with the FIX-39 reset flow). The current device stays signed
 * in: its session cookie is re-minted with an issued-at after the new
 * session epoch, so only other devices (and any stolen copy of the old
 * cookie) are signed out.
 *
 * The caller is identified by the middleware-set x-swarm-user header; a
 * forged header cannot work because middleware always overwrites it.
 * Only local accounts (id `local_<email>`) have a password to change;
 * non-local identities (harness, etc.) respond 400.
 *
 * The route is rate-limited with the strict login bucket (lib/rate-limit):
 * it verifies a credential, so it is a guessing surface like /api/login.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession, USER_HEADER } from "../../../../lib/auth";
import { recordAudit } from "../../../../lib/audit";
import { changeLocalPassword, emailForUserId, getSessionEpoch } from "../../../../lib/users";

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

/** Responses carry (or refuse) a session cookie: never cache them. */
const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(req: NextRequest): Promise<Response> {
  const id = req.headers.get(USER_HEADER);
  if (!id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }
  if (!id.startsWith("local_")) {
    return NextResponse.json(
      { error: "Only local accounts can change their password." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!process.env.SWARM_SESSION_SECRET) {
    // The success path re-mints the session cookie; without a secret it
    // cannot, so refuse up front instead of changing the password and
    // then failing to keep this device signed in.
    return NextResponse.json(
      { error: "Server is not configured for sessions." },
      { status: 500, headers: NO_STORE },
    );
  }

  const body = await readBody(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_STORE });
  }
  const { currentPassword, newPassword } = body;
  if (typeof currentPassword !== "string" || !currentPassword) {
    return NextResponse.json(
      { error: "Current password is required." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 1024) {
    return NextResponse.json(
      { error: "New password must be 8–1024 characters." },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await changeLocalPassword(emailForUserId(id), currentPassword, newPassword);
  if (!result.ok) {
    recordAudit({ user: id, action: "password.change", target: id, result: "failure" });
    switch (result.error) {
      case "wrong-current":
        return NextResponse.json(
          { error: "Current password is incorrect." },
          { status: 401, headers: NO_STORE },
        );
      case "busy":
        // The global scrypt concurrency cap and its wait queue are saturated.
        return NextResponse.json(
          { error: "Too many attempts right now. Try again shortly." },
          { status: 429, headers: { ...NO_STORE, "Retry-After": "1" } },
        );
      case "invalid":
        return NextResponse.json(
          { error: "New password must be 8–1024 characters." },
          { status: 400, headers: NO_STORE },
        );
      default:
        // "unknown" (account vanished under a live session) or "fatal"
        // (write failure): same opaque 500 as revoke-sessions.
        return NextResponse.json(
          { error: "Could not change password." },
          { status: 500, headers: NO_STORE },
        );
    }
  }

  recordAudit({ user: id, action: "password.change", target: id, result: "success" });

  // Keep this device signed in: every session issued at or before the new
  // epoch is revoked, so re-mint with an issued-at strictly after it. The
  // +1ms guard covers a re-mint inside the same millisecond as the epoch
  // bump; by the time the browser sends the new cookie it is no longer
  // future-issued (verifySignedSession rejects future issued-at).
  const sessionEpoch = getSessionEpoch(emailForUserId(id));
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  res.cookies.set(
    SESSION_COOKIE,
    signSession(id, Math.max(Date.now(), sessionEpoch + 1)),
    sessionCookieOptions(),
  );
  return res;
}
