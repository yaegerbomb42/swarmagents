/**
 * POST /api/me/revoke-sessions
 *
 * "Sign out everywhere": bumps the signed-in local account's session epoch so
 * every existing session cookie (on this device and any other) is invalidated.
 * The current device's cookie is also cleared so the user is signed out here
 * too. The caller is identified by the middleware-set x-swarm-user header; a
 * forged header cannot work because middleware always overwrites it.
 *
 * Only local accounts (id `local_<email>`) have a revocable epoch; non-local
 * identities (harness, etc.) respond 400.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, USER_HEADER } from "../../../../lib/auth";
import { recordAudit } from "../../../../lib/audit";
import { bumpSessionEpoch, emailForUserId } from "../../../../lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(req: NextRequest): Promise<Response> {
  const id = req.headers.get(USER_HEADER);
  if (!id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }
  if (!id.startsWith("local_")) {
    return NextResponse.json(
      { error: "Only local accounts can sign out everywhere." },
      { status: 400, headers: NO_STORE },
    );
  }

  const email = emailForUserId(id);
  if (!(await bumpSessionEpoch(email))) {
    recordAudit({ user: id, action: "session.revoke", target: id, result: "failure" });
    return NextResponse.json(
      { error: "Could not revoke sessions." },
      { status: 500, headers: NO_STORE },
    );
  }

  recordAudit({ user: id, action: "session.revoke", target: id, result: "success" });

  // Clear this device's cookie: everyone, including the person clicking the
  // button, is signed out everywhere.
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
