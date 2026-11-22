/**
 * GET /api/me
 *
 * Public endpoint the login page uses to see whether a session is already
 * active. The identity comes from the middleware-set x-swarm-user header
 * (middleware always overwrites it, so a client cannot forge it); when no
 * session exists it just reports null instead of failing — the page reacts
 * by showing the sign-in form.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../lib/auth";
import { emailForUserId } from "../../../lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_USER_ID_LEN = 128;

export function GET(req: NextRequest): Response {
  const raw = req.headers.get(USER_HEADER);
  const id = raw && raw.length > 0 && raw.length <= MAX_USER_ID_LEN ? raw : null;
  return NextResponse.json(
    { user: id ? { id, email: emailForUserId(id) } : null },
    { headers: { "cache-control": "no-store" } },
  );
}
