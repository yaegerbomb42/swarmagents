/**
 * POST /api/logout
 *
 * Sign out of THIS device/browser only: clear the current session cookie
 * without touching the account's session epoch, so sessions on other devices
 * stay valid. For sign-out-everywhere, use POST /api/me/revoke-sessions
 * (which bumps the epoch and invalidates every session cookie).
 *
 * The route is public (see middleware) so it always clears the cookie even
 * when the session is expired/invalid; when a valid session cookie is
 * present, the logout is recorded in that user's audit log.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  clearSessionCookieOptions,
  SESSION_COOKIE,
  verifySession,
} from "../../../lib/auth";
import { recordAudit } from "../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign-out responses are state-mutating: never cache them. */
const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(req: NextRequest): Promise<Response> {
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const uid = token ? verifySession(token) : null;
  if (uid) {
    recordAudit({ user: uid, action: "session.logout", target: uid, result: "success" });
  }

  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  res.cookies.set(SESSION_COOKIE, "", clearSessionCookieOptions());
  return res;
}
