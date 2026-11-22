/**
 * POST /api/password-reset/request (FIX-39)
 *
 * Start a password reset: when an account exists for the email, mint a
 * single-use, time-boxed reset token (lib/users) and email the reset link
 * (lib/mailer). The response is always 200 with the same body whether or
 * not the account exists — this endpoint must never be an account oracle.
 * The mail send is fire-and-forget so SMTP latency cannot leak account
 * existence through response timing either. Rate-limited by middleware
 * (passwordResetBucket in lib/rate-limit).
 */

import { NextResponse, type NextRequest } from "next/server";
import { issuePasswordResetToken, localUserExists, normalizeEmail, passwordResetTtlMs } from "../../../../lib/users";
import { mailConfigured, sendMail } from "../../../../lib/mailer";
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

/** Reset responses must never be cached (they are account-adjacent). */
const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * Public origin for the reset link: SWARM_PUBLIC_ORIGIN when configured,
 * else the request's (middleware-allowlisted) Host with the forwarded
 * protocol — the same derivation middleware uses for sign-in redirects.
 */
function publicOrigin(req: NextRequest): string {
  const configured = process.env.SWARM_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = req.headers.get("host") ?? "localhost";
  const forwardedProto = (req.headers.get("x-forwarded-proto") ?? "").trim().toLowerCase();
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "https";
  return `${proto}://${host}`;
}

function resetEmailText(link: string, ttlMinutes: number): string {
  return [
    "Someone asked to reset the password for your SwarmAgents account.",
    "",
    "Open this link to choose a new password:",
    link,
    "",
    `The link works once and expires in ${ttlMinutes} minutes.`,
    "If you did not ask for this, you can ignore this email — your password stays the same.",
  ].join("\n");
}

export async function POST(req: NextRequest): Promise<Response> {
  const body = await readBody(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_STORE });
  }

  const email = normalizeEmail(body.email);
  // One response for every outcome below: known account, unknown account,
  // invalid email, mail failure. Anything else is an account oracle.
  const accepted = NextResponse.json({ ok: true }, { headers: NO_STORE });

  if (!email || !localUserExists(email)) {
    recordAudit({
      user: "anonymous",
      action: "password.reset.request",
      target: typeof body.email === "string" && body.email ? body.email : "unknown",
      result: "failure",
    });
    return accepted;
  }

  let token: string | null = null;
  try {
    token = await issuePasswordResetToken(email);
  } catch (err) {
    // e.g. SWARM_SESSION_SECRET unset outside the boot guards. Log loudly
    // server-side; the caller still gets the same 200 as everyone else.
    console.error("[password-reset] could not issue reset token:", err);
  }
  if (!token) {
    recordAudit({ user: "anonymous", action: "password.reset.request", target: email, result: "failure" });
    return accepted;
  }

  const link = `${publicOrigin(req)}/reset-password?token=${encodeURIComponent(token)}`;
  const ttlMinutes = Math.max(1, Math.round(passwordResetTtlMs() / 60_000));
  if (!mailConfigured()) {
    console.error(
      "[password-reset] mail transport not configured; reset link cannot be delivered. " +
        "Set SWARM_SMTP_HOST and SWARM_MAIL_FROM — see DEPLOY.md.",
    );
  }
  // Fire-and-forget: awaiting SMTP would make known accounts measurably
  // slower than unknown ones (a timing oracle), and delivery failure must
  // not change the response. Failures are logged + audited server-side.
  void sendMail({ to: email, subject: "Reset your SwarmAgents password", text: resetEmailText(link, ttlMinutes) }).then(
    (result) => {
      recordAudit({
        user: "anonymous",
        action: "password.reset.request",
        target: email,
        result: result.ok ? "success" : "failure",
      });
      if (!result.ok) {
        console.error(`[password-reset] reset email to ${email} failed: ${result.error}`);
      }
    },
    (err: unknown) => {
      recordAudit({ user: "anonymous", action: "password.reset.request", target: email, result: "failure" });
      console.error("[password-reset] reset email send threw:", err);
    },
  );

  return accepted;
}
