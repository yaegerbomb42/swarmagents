/**
 * POST /api/signup
 *
 * Create a local password user and mint a session cookie for them.
 *
 * Accepts {email, password, botToken?}; the email is normalized (trimmed,
 * lowercase), passwords are hashed with scrypt in lib/users. Duplicates and
 * invalid input deliberately share one generic 400 response so this endpoint
 * cannot be used to enumerate registered email addresses (login does the same
 * with a generic 401).
 *
 * FIX-44: when the bot check is configured (SWARM_TURNSTILE_SECRET), a
 * valid Turnstile token is required before any account work happens.
 * New accounts start unverified: a verification link is emailed
 * (fire-and-forget) and, in server mode, the account cannot start runs
 * until the link is clicked (gate in lib/runtime/manager start()).
 */

import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieOptions, signSession, signupAllowed, SESSION_COOKIE } from "../../../lib/auth";
import { signupLocalUser } from "../../../lib/users";
import { botCheckConfigured, verifyBotToken } from "../../../lib/bot-check";
import { sendVerificationEmail } from "../../../lib/verification-email";
import { recordAudit } from "../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 16 * 1024;

/**
 * One generic message for malformed signups and for duplicate emails. Keeping
 * a single constant (rather than two independent string literals) guarantees
 * the two cases stay byte-for-byte identical in both status and body, so a
 * caller cannot tell a registered address from an invalid submission.
 */
const GENERIC_SIGNUP_ERROR = "Enter a valid email and a password of at least 8 characters.";

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

export async function POST(req: NextRequest): Promise<Response> {
  if (!process.env.SWARM_SESSION_SECRET) {
    return NextResponse.json({ error: "Server is not configured for sessions." }, { status: 500 });
  }

  // Self-signup gate: signupAllowed() in lib/auth is the single source of
  // truth — the login page renders its "Create account" toggle from the
  // same predicate, so the toggle can never offer a sign-up this route
  // would reject. Closed in server mode (every environment) and in
  // production unless SWARM_ALLOW_SIGNUP=1|true; open in local mode, which
  // trusts loopback only and where creating the first local account is
  // the intended flow. See lib/auth.ts for the full rationale.
  if (!signupAllowed()) {
    return NextResponse.json({ error: "Sign-up is disabled on this server." }, { status: 403 });
  }

  const body = await readBody(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Bot check (FIX-44): accounts consume VM compute, so when the check
  // is configured it runs before any account work — a failed check
  // creates nothing and burns no scrypt. Unconfigured deployments
  // (local mode, closed sign-ups) skip it; see lib/bot-check.
  if (botCheckConfigured()) {
    const remoteIp = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || undefined;
    const bot = await verifyBotToken(body.botToken, { remoteIp });
    if (!bot.ok) {
      recordAudit({
        user: "anonymous",
        action: "signup.botcheck",
        target: typeof body.email === "string" && body.email ? body.email : "unknown",
        result: "failure",
      });
      return NextResponse.json({ error: "Bot check failed. Please try again." }, { status: 400 });
    }
  }

  const result = await signupLocalUser(body.email, body.password);
  if (!result.ok) {
    switch (result.error) {
      case "fatal":
        return NextResponse.json({ error: "Could not persist the account." }, { status: 500 });
      case "busy":
        // The global scrypt concurrency cap is saturated: shed load rather
        // than queue an unbounded number of password hashes.
        return NextResponse.json(
          { error: "Too many sign-up attempts right now. Try again shortly." },
          { status: 429, headers: { "Retry-After": "1" } },
        );
      case "exists":
      case "invalid":
      default:
        // A taken email and a malformed submission are intentionally
        // indistinguishable here: same status, same body, no 409.
        return NextResponse.json({ error: GENERIC_SIGNUP_ERROR }, { status: 400 });
    }
  }

  // The account starts unverified (FIX-44): email the verification link
  // now. Fire-and-forget inside sendVerificationEmail — delivery latency
  // or failure never shapes this response, and the user can resend from
  // /verify-email while signed in.
  await sendVerificationEmail(req, result.user.email);

  const res = NextResponse.json(
    { ok: true, user: result.user, emailVerification: "pending" },
    { status: 201 },
  );
  res.cookies.set(SESSION_COOKIE, signSession(result.user.uid), sessionCookieOptions());
  return res;
}
