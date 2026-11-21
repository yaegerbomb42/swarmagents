/**
 * POST /api/logout
 *
 * Clear the caller's session cookie. Gated against CSRF in middleware
 * (same-origin policy on state-changing API routes). Unauthenticated or
 * already-logged-out callers still receive 200 { ok: true } so this endpoint
 * is not an account oracle.
 */

import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookieOptions, SESSION_COOKIE } from "../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(_req: NextRequest): Promise<Response> {
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  res.cookies.set(SESSION_COOKIE, "", clearSessionCookieOptions());
  return res;
}
