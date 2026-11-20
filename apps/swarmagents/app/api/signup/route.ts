/**
 * POST /api/signup
 *
 * Create a local password user and mint a session cookie for them.
 *
 * Accepts {email, password}; the email is normalized (trimmed, lowercase),
 * passwords are hashed with scrypt in lib/users, and duplicates return a
 * 409 without disclosing whether the account exists for other purposes.
 */

import { NextResponse, type NextRequest } from "next/server";
import { serverMode, sessionCookieOptions, signSession, SESSION_COOKIE } from "../../../lib/auth";
import { signupLocalUser } from "../../../lib/users";

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

export async function POST(req: NextRequest): Promise<Response> {
  if (!process.env.SWARM_SESSION_SECRET) {
    return NextResponse.json({ error: "Server is not configured for sessions." }, { status: 500 });
  }

  // Self-signup is closed unless explicitly enabled. The old rule closed
  // it only when NODE_ENV=production, which left every non-production
  // server-mode deployment (staging, a test server, a demo box) openly
  // creating accounts for anyone who could reach it. The rule now keys on
  // server mode instead: in server mode signup needs SWARM_ALLOW_SIGNUP=1
  // in every environment (production included — NODE_ENV=production on its
  // own still closes it, so a production deploy without server mode set
  // keeps the old behaviour). Local mode stays open: it trusts loopback
  // only, and creating the first local account is the intended local flow.
  const allow = (process.env.SWARM_ALLOW_SIGNUP ?? "").toLowerCase();
  const signupClosed =
    (serverMode() || process.env.NODE_ENV === "production") && allow !== "1" && allow !== "true";
  if (signupClosed) {
    return NextResponse.json({ error: "Sign-up is disabled on this server." }, { status: 403 });
  }

  const body = await readBody(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const result = await signupLocalUser(body.email, body.password);
  if (!result.ok) {
    switch (result.error) {
      case "exists":
        return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
      case "fatal":
        return NextResponse.json({ error: "Could not persist the account." }, { status: 500 });
      case "busy":
        // The global scrypt concurrency cap is saturated: shed load rather
        // than queue an unbounded number of password hashes.
        return NextResponse.json(
          { error: "Too many sign-up attempts right now. Try again shortly." },
          { status: 429, headers: { "Retry-After": "1" } },
        );
      default:
        return NextResponse.json({ error: "Enter a valid email and a password of at least 8 characters." }, { status: 400 });
    }
  }

  const res = NextResponse.json({ ok: true, user: result.user }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, signSession(result.user.uid), sessionCookieOptions());
  return res;
}
