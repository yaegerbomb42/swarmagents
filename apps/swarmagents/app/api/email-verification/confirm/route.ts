/**
 * POST /api/email-verification/confirm (FIX-44)
 *
 * Consume the single-use token from the verification email: marks the
 * account verified (lib/users), which lifts the server-mode run-start
 * gate. The token is the credential, so the route is public (middleware
 * PUBLIC set) and rate-limited with the password-reset bucket. One
 * generic 400 for unknown/expired/reused tokens — the caller cannot
 * distinguish them. No session is minted: the user signs in (or is
 * already signed in from sign-up) with their password.
 */

import { NextResponse, type NextRequest } from "next/server";
import { consumeEmailVerificationToken } from "../../../../lib/users";
import { recordAudit } from "../../../../lib/audit";

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

/** Verification responses are account-adjacent: never cache them. */
const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(req: NextRequest): Promise<Response> {
  const body = await readBody(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_STORE });
  }

  const email = await consumeEmailVerificationToken(body.token);
  if (!email) {
    recordAudit({ user: "anonymous", action: "email.verify", target: "unknown", result: "failure" });
    return NextResponse.json(
      { error: "This verification link is invalid or has expired. Sign in and resend it from the verify page." },
      { status: 400, headers: NO_STORE },
    );
  }

  recordAudit({ user: "anonymous", action: "email.verify", target: email, result: "success" });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
