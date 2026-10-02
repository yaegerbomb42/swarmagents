"use client";

import { useEffect, useState } from "react";
import { Wordmark, HexagonMark } from "@/components/Brand";
import { passwordChecks, signupCredentialsError } from "@/lib/credentials";
import "./login.css";
import { SignupCaptcha } from "@/components/SignupCaptcha"; // deploy lane: ALTCHA sign-up check (Jimmy 23:14)

interface Me {
  mode: "local" | "server";
  user: { username: string; isAdmin: boolean } | null;
  signup?: "invite" | "open" | "closed";
  needsAdmin?: boolean;
}

const SR_ONLY: React.CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

/** Only same-site paths: `?next=//evil.com` or `?next=https://…` falls back to "/". */
function nextPath() {
  const next = new URLSearchParams(location.search).get("next") ?? "/";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export default function Login() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [forgot, setForgot] = useState(false);
  // The sign-up human check: a solved ALTCHA payload, single use, so it's remounted (new challenge) after any failed sign-up.
  const [altcha, setAltcha] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  useEffect(() => {
    const code = new URLSearchParams(location.search).get("invite");
    if (code) {
      setInvite(code);
      setTab("signup");
    }
    fetch("/api/me")
      .then((r) => r.json() as Promise<Me>)
      .then((m) => {
        if (m.user) return location.replace(nextPath());
        setMe(m);
        if (m.needsAdmin) setTab("signup");
      })
      .catch(() => setMe({ mode: "server", user: null, signup: "invite" }));
  }, []);

  const signup = tab === "signup";
  // The exact rules /api/signup enforces (lib/credentials.ts), so the form never accepts what the server rejects.
  const checks = passwordChecks(password);
  const signupError = signup ? signupCredentialsError(username.trim(), password) : null;
  const canSignup = !!me && (me.needsAdmin || me.signup !== "closed");
  const needInvite = !!me?.needsAdmin || me?.signup === "invite";
  const needCaptcha = signup && !me?.needsAdmin;
  const title = me?.needsAdmin ? "Create the admin account" : signup ? "Create an account" : "Sign in";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (signupError) return setError(signupError);
    setBusy(true);
    setError("");
    const r = await fetch(signup ? "/api/signup" : "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signup ? { username: username.trim(), password, invite: invite.trim(), altcha } : { username: username.trim(), password }),
    }).catch(() => null);
    if (r?.ok) return location.replace(nextPath());
    if (signup) {
      setAltcha(null);
      setCaptchaKey((k) => k + 1);
    }
    const body = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : {};
    setError(!r ? "Can't reach the server. Check your connection and try again." : (body.error ?? (r.status === 429 ? "Too many attempts. Wait a few minutes and try again." : `Something went wrong (${r.status}).`)));
    setBusy(false);
  }

  function switchTab(t: "signin" | "signup") {
    setTab(t);
    setError("");
    setForgot(false);
  }

  return (
    <main className="login-page">
      <form className="login-form" onSubmit={submit} noValidate>
        <div className="login-brand">
          <HexagonMark size={56} state="idle" />
          <Wordmark width={220} />
        </div>
        <h1>{title}</h1>
        {me?.needsAdmin ? (
          <p className="login-subtitle">This server has no accounts yet. Enter the owner token from the deploy as the invite code; this account becomes the admin.</p>
        ) : (
          canSignup && (
            <div className="login-tabs" role="tablist">
              {(["signin", "signup"] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={`login-tab ${tab === t ? "active" : ""}`} onClick={() => switchTab(t)}>
                  {t === "signin" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>
          )
        )}

        <div className="login-fields">
          <label htmlFor="username" className="field-label">
            {signup ? "Username" : "Username or email"}
            {signup && <span className="field-hint">3–32 letters, digits, . - _</span>}
          </label>
          <div className="input-wrapper">
            <input
              id="username"
              name="username"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
              placeholder={signup ? "e.g. alice" : "alice or you@example.com"}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
            />
          </div>

          <label htmlFor="password" className="field-label">
            Password
          </label>
          <div className="input-wrapper password-wrapper">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete={signup ? "new-password" : "current-password"}
              placeholder={signup ? "Make it 10+ characters" : "Your password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              aria-describedby={signup ? "password-rules" : undefined}
            />
            <button type="button" className="toggle-visibility" onClick={() => setShowPassword((s) => !s)} aria-pressed={showPassword} aria-label={showPassword ? "Hide password" : "Show password"}>
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>

          {signup && (
            <ul id="password-rules" className="password-rules" aria-live="polite">
              {checks.map((c) => (
                <li key={c.id} className={c.ok ? "met" : "unmet"}>
                  {c.label}
                  <span style={SR_ONLY}>{c.ok ? " (done)" : " (needed)"}</span>
                </li>
              ))}
            </ul>
          )}

          {signup && needInvite && (
            <>
              <label htmlFor="invite" className="field-label">
                {me?.needsAdmin ? "Owner token" : "Invite code"}
              </label>
              <div className="input-wrapper">
                <input id="invite" name="invite" autoComplete="off" spellCheck={false} placeholder={me?.needsAdmin ? "Owner token from the deploy" : "From the person who invited you"} value={invite} onChange={(e) => setInvite(e.target.value)} disabled={busy} />
              </div>
            </>
          )}

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          {needCaptcha && <SignupCaptcha key={captchaKey} onChange={setAltcha} />}

          <button className="btn primary login-submit" disabled={busy || !username.trim() || !password || (signup && (!!signupError || (needInvite && !invite.trim()) || (needCaptcha && !altcha)))} type="submit">
            {busy ? (signup ? "Creating account…" : "Signing in…") : signup ? "Create account" : "Sign in"}
          </button>

          {!signup && (
            <div className="login-footer">
              <button type="button" className="forgot-password" aria-expanded={forgot} onClick={() => setForgot((f) => !f)}>
                Forgot password?
              </button>
              {forgot && <p className="login-subtitle">There's no self-serve reset yet. Ask the admin of this server to help you get back in.</p>}
            </div>
          )}
        </div>
      </form>
    </main>
  );
}
