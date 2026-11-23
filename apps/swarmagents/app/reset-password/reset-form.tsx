"use client";

/**
 * Set-a-new-password form for the FIX-39 reset flow. POSTs {token,
 * password} to /api/password-reset/confirm; on success the user signs in
 * fresh (the confirm route revokes every existing session and mints
 * none). Styled to match the login form (app/login/login-form.tsx).
 */

import { useState, type CSSProperties, type FormEvent } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--color-bg-sunken)",
  border: "1px solid var(--color-line-strong)",
  color: "var(--color-text)",
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  padding: "10px 40px 10px 12px",
  borderRadius: "var(--radius-sm, 6px)",
  outline: "none",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--color-text-muted)",
  marginBottom: 6,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const toggleButtonStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  right: 6,
  transform: "translateY(-50%)",
  background: "transparent",
  border: "none",
  color: "var(--color-text-muted)",
  cursor: "pointer",
  padding: 6,
  lineHeight: 0,
  borderRadius: "var(--radius-xs, 4px)",
};

function Spinner() {
  return (
    <span aria-hidden="true" data-testid="reset-spinner" style={{ display: "inline-flex" }}>
      <Loader2 size={16} className="animate-spin" />
    </span>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  show,
  onToggleShow,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  testId: string;
}) {
  return (
    <div>
      <label style={labelStyle} htmlFor={id}>{label}</label>
      <div style={{ position: "relative" }}>
        <input
          id={id}
          type={show ? "text" : "password"}
          required
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        />
        <button
          type="button"
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          data-testid={testId}
          onClick={onToggleShow}
          style={toggleButtonStyle}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

export default function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/password-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Password reset failed.");
        return;
      }
      setDone(true);
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
        data-testid="reset-card"
        style={{
          width: 360,
          maxWidth: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          padding: "var(--space-6, 24px)",
          borderRadius: "var(--radius-lg, 12px)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
            marginBottom: 4,
          }}
        >
          {/* Brand mark + wordmark (branding/BRAND.md) — same lockup as
              the workspace Header and the login page; hand-built SVG. */}
          <span data-testid="brand-lockup" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/mark-dark.svg" alt="" aria-hidden="true" width={32} height={32} />
            <span
              data-testid="reset-wordmark"
              style={{
                fontSize: "clamp(1rem, 4vw + 0.25rem, 1.25rem)",
                fontWeight: 600,
                letterSpacing: "-0.02em",
                whiteSpace: "nowrap",
                color: "var(--color-text)",
              }}
            >
              SwarmAgents
            </span>
          </span>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: "0 0 24px" }}>
          Choose a new password for your account.
        </p>

        {!token ? (
          <div data-testid="reset-missing-token">
            <p role="alert" style={{ color: "var(--color-err)", fontSize: 13, margin: "0 0 16px" }}>
              This reset link is missing its token. Request a new one from the sign-in page.
            </p>
            <a
              href="/login"
              style={{ color: "var(--color-focus)", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 3 }}
            >
              Back to sign in
            </a>
          </div>
        ) : done ? (
          <div data-testid="reset-done">
            <p style={{ color: "var(--color-text)", fontSize: 14, margin: "0 0 16px" }}>
              Your password has been updated. Every existing session was signed out — sign in with your new
              password.
            </p>
            <a
              href="/login"
              data-testid="reset-signin-link"
              style={{ color: "var(--color-focus)", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 3 }}
            >
              Sign in
            </a>
          </div>
        ) : (
          <form onSubmit={submit} className="reset-form" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <PasswordField
              id="new-password"
              label="New password"
              value={password}
              onChange={setPassword}
              show={showPassword}
              onToggleShow={() => setShowPassword((v) => !v)}
              testId="reset-password-toggle"
            />
            <PasswordField
              id="confirm-password"
              label="Confirm new password"
              value={confirm}
              onChange={setConfirm}
              show={showPassword}
              onToggleShow={() => setShowPassword((v) => !v)}
              testId="reset-confirm-toggle"
            />

            {error && (
              <p role="alert" style={{ color: "var(--color-err)", fontSize: 13, margin: 0 }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              data-testid="reset-submit"
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
              {busy ? "Updating password…" : "Set new password"}
            </button>

            <a
              href="/login"
              style={{
                color: "var(--color-focus)",
                fontSize: 13,
                alignSelf: "center",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              Back to sign in
            </a>
          </form>
        )}
      </div>
    </main>
  );
}
