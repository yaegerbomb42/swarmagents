"use client";

import { useEffect, useState } from "react";
import { Wordmark, HexagonMark } from "@/components/Brand";
import { IX } from "@/components/icons";

interface Me {
  mode: "local" | "server";
  user: { username: string; isAdmin: boolean } | null;
  signup?: "invite" | "open" | "closed";
  needsAdmin?: boolean;
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
  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("invite");
    if (code) {
      setInvite(code);
      setTab("signup");
    }
    fetch("/api/me")
      .then((r) => r.json() as Promise<Me>)
      .then((m) => {
        if (m.user) return go();
        setMe(m);
        if (m.needsAdmin) setTab("signup");
      })
      .catch(() => setMe({ mode: "server", user: null, signup: "invite" }));
  }, []);

  function go() {
    const next = new URLSearchParams(location.search).get("next") ?? "/";
    location.replace(next.startsWith("/") && !next.startsWith("//") ? next : "/");
  }

  const validatePassword = (pwd: string) => {
    const errors: string[] = [];
    if (pwd.length < 10) errors.push("At least 10 characters");
    if (!/[A-Z]/.test(pwd)) errors.push("One uppercase letter");
    if (!/[a-z]/.test(pwd)) errors.push("One lowercase letter");
    if (!/[0-9]/.test(pwd)) errors.push("One number");
    if (!/[^A-Za-z0-9]/.test(pwd)) errors.push("One special character");
    return errors;
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pwd = e.target.value;
    setPassword(pwd);
    if (tab === "signup") {
      setPasswordErrors(validatePassword(pwd));
    }
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");

    if (tab === "signup") {
      const pwdErrors = validatePassword(password);
      if (pwdErrors.length > 0) {
        setError(`Password must have: ${pwdErrors.join(", ")}`);
        setBusy(false);
        return;
      }
      if (!username.trim()) {
        setError("Username is required");
        setBusy(false);
        return;
      }
      if (username.length < 3) {
        setError("Username must be at least 3 characters");
        setBusy(false);
        return;
      }
    }

    const r = await fetch(tab === "signin" ? "/api/login" : "/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, invite }),
    }).catch(() => null);
    if (r?.ok) return go();
    setError(r ? (((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Something went wrong.") : "Can't reach the server.");
    setBusy(false);
  }

  const canSignup = !!me && (me.needsAdmin || me.signup !== "closed");
  const needInvite = !!me?.needsAdmin || me?.signup === "invite";
  const title = me?.needsAdmin ? "Create the admin account" : tab === "signin" ? "Sign in" : "Create an account";
  const isPasswordValid = tab === "signup" ? validatePassword(password).length === 0 : true;

  return (
    <main className="login-page">
      <form className="login-form" onSubmit={submit}>
        <div className="login-brand">
          <HexagonMark size={56} state="idle" />
          <Wordmark width={220} />
        </div>
        <h1>{title}</h1>
        {me?.needsAdmin ? (
          <p className="login-subtitle">
            This server has no accounts yet. Use the owner token from the deploy as the invite code; this account becomes the admin.
          </p>
        ) : (
          canSignup && (
            <div className="login-tabs" role="tablist">
              {(["signin", "signup"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={`login-tab ${tab === t ? "active" : ""}`}
                  onClick={() => {
                    setTab(t);
                    setError("");
                    setPasswordErrors([]);
                  }}
                >
                  {t === "signin" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>
          )
        )}
        
        <div className="login-fields">
          <label htmlFor="username" className="field-label">Username</label>
          <div className="input-wrapper">
            <input
              id="username"
              autoFocus
              autoComplete="username"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
            />
          </div>

          <label htmlFor="password" className="field-label">
            {tab === "signin" ? "Password" : "Password"}
            {tab === "signup" && <span className="field-hint">(10+ chars, upper, lower, number, symbol)</span>}
          </label>
          <div className="input-wrapper password-wrapper">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete={tab === "signin" ? "current-password" : "new-password"}
              placeholder={tab === "signin" ? "Password" : "Password (10+ characters)"}
              value={password}
              onChange={handlePasswordChange}
              disabled={busy}
            />
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <IX /> : <span style={{ opacity: 0.5 }}>👁</span>}
            </button>
          </div>

          {tab === "signup" && password && passwordErrors.length > 0 && (
            <ul className="password-rules" role="alert">
              {passwordErrors.map((err, i) => (
                <li key={i} className={validatePassword(password).includes(err) ? "unmet" : "met"}>
                  {err}
                </li>
              ))}
            </ul>
          )}

          {tab === "signup" && needInvite && (
            <>
              <label htmlFor="invite" className="field-label">
                {me?.needsAdmin ? "Owner token" : "Invite code"}
              </label>
              <div className="input-wrapper">
                <input
                  id="invite"
                  autoComplete="off"
                  placeholder={me?.needsAdmin ? "Owner token from deploy" : "Invite code"}
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  disabled={busy}
                />
              </div>
            </>
          )}

          {error && <p className="error" role="alert">{error}</p>}

          <button
            className="btn primary login-submit"
            disabled={busy || !username || !password || (tab === "signup" && needInvite && !invite) || (tab === "signup" && !isPasswordValid)}
            type="submit"
          >
            {busy ? "…" : tab === "signin" ? "Sign in" : "Create account"}
          </button>

          {tab === "signin" && (
            <div className="login-footer">
              <button
                type="button"
                className="forgot-password"
                onClick={() => {
                  alert("Forgot password flow: A decision is needed on the reset mechanism (email, admin reset, or local recovery). Posted in GROUP_CHAT for team input.");
                }}
              >
                Forgot password?
              </button>
            </div>
          )}
        </div>
      </form>
    </main>
  );
}
