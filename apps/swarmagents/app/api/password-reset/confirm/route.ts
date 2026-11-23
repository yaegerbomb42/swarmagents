/**
 * POST /api/password-reset/confirm (FIX-39)
 *
 * Finish a password reset: consume the single-use token (lib/users),
 * scrypt-hash the new password and revoke every existing session for the
 * account (setUserPassword raises the session epoch in the same write).
 * Unknown, expired and already-used tokens all get the same generic 400 —
 * the response never says which. No session is minted here: the user
 * signs in fresh with the new password. Rate-limited by middleware
 * (passwordResetBucket in lib/rate-limit).
 */

import { NextResponse, type NextRequest } from "next/server";
import { consumePasswordResetToken, localUserIdForEmail, setUserPassword } from "../../../../lib/users";
import { recordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 16 * 1024;

/** Same password policy as signup (lib/users MIN/MAX_PASSWORD_LEN). */
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 1024;

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

/** Reset responses must never be cached (they are account-adjacent). */
const NO_STORE = { "cache-control": "no-store" } as const;

/** One message for every token failure: unknown, expired, or reused. */
const INVALID_TOKEN = { error: "This reset link is invalid or has expired." } as const;

export async function POST(req: NextRequest): Promise<Response> {
  const body = await readBody(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_STORE });
  }

  // Password policy first: it is the same answer for every token, valid
  // or not, so checking it first leaks nothing about the token.
  const password = body.password;
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
    return NextResponse.json(
      { error: `Enter a password of at least ${MIN_PASSWORD_LEN} characters.` },
      { status: 400, headers: NO_STORE },
    );
  }

  const email = await consumePasswordResetToken(body.token);
  if (!email) {
    // Never log the token itself — it is a credential until consumed.
    recordAudit({ user: "anonymous", action: "password.reset", target: "unknown", result: "failure" });
    return NextResponse.json(INVALID_TOKEN, { status: 400, headers: NO_STORE });
  }

  const result = await setUserPassword(email, password);
  if (!result.ok) {
    recordAudit({ user: localUserIdForEmail(email), action: "password.reset", target: localUserIdForEmail(email), result: "failure" });
    if (result.error === "busy") {
      return NextResponse.json(
        { error: "Too many attempts right now. Try again shortly." },
        { status: 429, headers: { ...NO_STORE, "Retry-After": "1" } },
      );
    }
    if (result.error === "invalid") {
      return NextResponse.json(
        { error: `Enter a password of at least ${MIN_PASSWORD_LEN} characters.` },
        { status: 400, headers: NO_STORE },
      );
    }
    // "unknown" (account vanished mid-flow) and "fatal" (write failed):
    // the token is already consumed, so ask for a fresh link generically.
    return NextResponse.json(INVALID_TOKEN, { status: 400, headers: NO_STORE });
  }

  recordAudit({ user: localUserIdForEmail(email), action: "password.reset", target: localUserIdForEmail(email), result: "success" });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
