"use client";

/**
 * Sign-in / sign-up form for local password users. POSTs email/password to
 * /api/login (or /api/signup when creating an account); the `next` target on
 * success is always the server-validated `next` echoed back by the API. On
 * failure the API's error is shown inline.
 */

import { useState, type CSSProperties, type FormEvent } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { safeNextPath } from "../../lib/safe-next";

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
    <span aria-hidden="true" data-testid="login-spinner" style={{ display: "inline-flex" }}>
      <Loader2 size={16} className="animate-spin" />
    </span>
  );
}

export default function LoginForm({ next, allowSignup }: { next: string; allowSignup: boolean }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignup = mode === "signup";

  function switchMode() {
    setError(null);
    setMode(isSignup ? "signin" : "signup");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(isSignup ? "/api/signup" : "/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isSignup ? { email, password } : { email, password, next }),
      });
      const data = (await res.json()) as { error?: string; next?: string };
      if (!res.ok) {
        setError(data.error ?? (isSignup ? "Account creation failed." : "Sign-in failed."));
        return;
      }
      // Only ever trust the server-echoed (validated) next value.
      window.location.assign(safeNextPath(isSignup ? next : data.next));
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
        data-testid="login-card"
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/logo.png"
            alt=""
            aria-hidden="true"
            width={28}
            height={28}
            style={{ flexShrink: 0 }}
            // The logo lives behind Git LFS; if it is unresolved, hide the
            // element rather than painting a broken image.
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
          <h1
            data-testid="login-wordmark"
            style={{
              fontSize: "clamp(1rem, 4vw + 0.25rem, 1.25rem)",
              fontWeight: 600,
              margin: 0,
              letterSpacing: "-0.02em",
              whiteSpace: "nowrap",
              overflow: "visible",
              minWidth: 0,
            }}
          >
            SwarmAgents
          </h1>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: "0 0 24px" }}>
          {isSignup ? "Create your account to continue." : "Sign in to continue."}
        </p>

        <form onSubmit={submit} className="login-form" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={labelStyle} htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="password">Password</label>
            <div style={{ position: "relative" }}>
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete={isSignup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                data-testid="password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                style={toggleButtonStyle}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" style={{ color: "var(--color-err)", fontSize: 13, margin: 0 }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            data-testid="login-submit"
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
            {busy
              ? isSignup ? "Creating account…" : "Signing in…"
              : isSignup ? "Create account" : "Sign in"}
          </button>

          {allowSignup && (
            <button
              type="button"
              data-testid="signup-toggle"
              onClick={switchMode}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-focus)",
                fontSize: 13,
                cursor: "pointer",
                padding: 0,
                alignSelf: "center",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              {isSignup ? "Have an account? Sign in" : "Create account"}
            </button>
          )}
        </form>
      </div>
    </main>
  );
}
