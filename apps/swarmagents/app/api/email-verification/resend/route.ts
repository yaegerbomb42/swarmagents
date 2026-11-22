/**
 * POST /api/email-verification/resend (FIX-44)
 *
 * Re-issue and re-email the verification link for the signed-in local
 * account. The caller is identified by the middleware-set x-swarm-user
 * header (middleware always overwrites it, so it cannot be forged).
 * Authenticated-only by design: an anonymous resend endpoint would let
 * anyone spam verification mail at any address and probe which accounts
 * are unverified.
 *
 * Always 200 for a signed-in local account: an already-verified account
 * gets the same response (and no mail), so the endpoint reveals nothing
 * beyond what the caller already knows about their own account.
 * Rate-limited with the password-reset bucket (lib/rate-limit).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { emailForUserId, isEmailVerified } from "../../../../lib/users";
import { sendVerificationEmail } from "../../../../lib/verification-email";
import { recordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Responses are account-adjacent: never cache them. */
const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(req: NextRequest): Promise<Response> {
  const id = req.headers.get(USER_HEADER);
  if (!id) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
  }
  if (!id.startsWith("local_")) {
    return NextResponse.json(
      { error: "Email verification applies to local password accounts only." },
      { status: 400, headers: NO_STORE },
    );
  }

  const email = emailForUserId(id);
  if (isEmailVerified(email)) {
    // Nothing to send; same 200 as the send path.
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  await sendVerificationEmail(req, email);
  recordAudit({ user: id, action: "email.verify.resend", target: email, result: "success" });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
