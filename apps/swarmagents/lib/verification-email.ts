/**
 * Verification-email sender (FIX-44), shared by the signup route (first
 * send) and the resend route. Mirrors the FIX-39 reset-request pattern:
 * the send is fire-and-forget so SMTP latency never shapes a response,
 * and failures are logged + audited server-side only.
 */

import type { NextRequest } from "next/server";
import { emailVerificationTtlMs, issueEmailVerificationToken } from "./users";
import { mailConfigured, sendMail } from "./mailer";
import { recordAudit } from "./audit";

/**
 * Public origin for the emailed link: SWARM_PUBLIC_ORIGIN when
 * configured, else the request's (middleware-allowlisted) Host with the
 * forwarded protocol — the same derivation the FIX-39 reset route uses.
 */
export function publicOriginForRequest(req: NextRequest): string {
  const configured = process.env.SWARM_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = req.headers.get("host") ?? "localhost";
  const forwardedProto = (req.headers.get("x-forwarded-proto") ?? "").trim().toLowerCase();
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "https";
  return `${proto}://${host}`;
}

function verificationEmailText(link: string, ttlHours: number): string {
  return [
    "Welcome to SwarmAgents — one step left before your first run.",
    "",
    "Open this link to verify your email address:",
    link,
    "",
    `The link works once and expires in ${ttlHours} hours.`,
    "If you did not create this account, you can ignore this email.",
  ].join("\n");
}

/**
 * Issue a fresh verification token for `email` and email the link.
 * Fire-and-forget: returns as soon as the token is issued (or issuance
 * failed); delivery outcome is audited under `email.verify.resend`
 * (the action covers both the signup send and explicit resends — the
 * target distinguishes nothing sensitive, just the account email).
 * Never throws.
 */
export async function sendVerificationEmail(req: NextRequest, email: string): Promise<void> {
  let token: string | null = null;
  try {
    token = await issueEmailVerificationToken(email);
  } catch (err) {
    // e.g. SWARM_SESSION_SECRET unset outside the boot guards. Log loudly
    // server-side; the account exists and can resend once fixed.
    console.error("[email-verification] could not issue verification token:", err);
  }
  if (!token) {
    recordAudit({ user: "anonymous", action: "email.verify.resend", target: email, result: "failure" });
    return;
  }
  const link = `${publicOriginForRequest(req)}/verify-email?token=${encodeURIComponent(token)}`;
  const ttlHours = Math.max(1, Math.round(emailVerificationTtlMs() / 3_600_000));
  if (!mailConfigured()) {
    console.error(
      "[email-verification] mail transport not configured; verification link cannot be delivered. " +
        "Set SWARM_SMTP_HOST and SWARM_MAIL_FROM — see DEPLOY.md.",
    );
  }
  void sendMail({ to: email, subject: "Verify your SwarmAgents email", text: verificationEmailText(link, ttlHours) }).then(
    (result) => {
      recordAudit({
        user: "anonymous",
        action: "email.verify.resend",
        target: email,
        result: result.ok ? "success" : "failure",
      });
      if (!result.ok) {
        console.error(`[email-verification] verification email to ${email} failed: ${result.error}`);
      }
    },
    (err: unknown) => {
      recordAudit({ user: "anonymous", action: "email.verify.resend", target: email, result: "failure" });
      console.error("[email-verification] verification email send threw:", err);
    },
  );
}
