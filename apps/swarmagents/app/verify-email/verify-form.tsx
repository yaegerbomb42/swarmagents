"use client";

/**
 * Verify-email form for the FIX-44 flow. With a token (from the emailed
 * link) it POSTs {token} to /api/email-verification/confirm; without one
 * it offers the signed-in resend (POST /api/email-verification/resend),
 * which is how a user whose link expired recovers. Styled to match the
 * login form (app/login/login-form.tsx).
 */

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

function Spinner() {
  return (
    <span aria-hidden="true" data-testid="verify-spinner" style={{ display: "inline-flex" }}>
      <Loader2 size={16} className="animate-spin" />
    </span>
  );
}

export default function VerifyForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [resent, setResent] = useState(false);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/email-verification/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Verification failed. Please try again.");
        return;
      }
      setDone(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resend(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/email-verification/resend", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(
          res.status === 401
            ? "Sign in first, then resend the verification email."
            : data.error ?? "Could not resend. Please try again.",
        );
        return;
      }
      setResent(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-bg)",
        padding: "var(--space-5, 20px)",
      }}
    >
      <div
        className="glass"
        data-testid="verify-card"
        style={{
          width: 360,
          maxWidth: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          padding: "var(--space-6, 24px)",
          borderRadius: "var(--radius-lg, 12px)",
        }}
      >
        <h1
          data-testid="verify-wordmark"
          style={{ fontSize: "1.25rem", fontWeight: 600, margin: "0 0 4px", letterSpacing: "-0.02em" }}
        >
          SwarmAgents
        </h1>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: "0 0 24px" }}>
          {done
            ? "Your email is verified — you can start runs now."
            : token
              ? "Confirm your email address to finish setting up your account."
              : "Your account needs a verified email before it can start runs. Resend the verification email to your inbox."}
        </p>

        {error && (
          <p role="alert" style={{ color: "var(--color-err)", fontSize: 13, margin: "0 0 16px" }}>
            {error}
          </p>
        )}
        {resent && (
          <p role="status" data-testid="verify-resent" style={{ color: "var(--color-text)", fontSize: 13, margin: "0 0 16px" }}>
            A new verification link is on its way — check your inbox.
          </p>
        )}

        {done ? (
          <Link
            href="/"
            data-testid="verify-continue"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
              padding: "10px 16px",
              borderRadius: "var(--radius-sm, 6px)",
              fontSize: 14,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Continue to SwarmAgents
          </Link>
        ) : token ? (
          <form onSubmit={confirm} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <button
              type="submit"
              disabled={busy}
              data-testid="verify-submit"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
                border: "none",
                padding: "10px 16px",
                borderRadius: "var(--radius-sm, 6px)",
                fontSize: 14,
                fontWeight: 600,
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.85 : 1,
              }}
            >
              {busy ? <Spinner /> : null}
              {busy ? "Verifying…" : "Verify my email"}
            </button>
          </form>
        ) : (
          <form onSubmit={resend} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <button
              type="submit"
              disabled={busy}
              data-testid="verify-resend-submit"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
                border: "none",
                padding: "10px 16px",
                borderRadius: "var(--radius-sm, 6px)",
                fontSize: 14,
                fontWeight: 600,
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.85 : 1,
              }}
            >
              {busy ? <Spinner /> : null}
              {busy ? "Sending…" : "Resend verification email"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
