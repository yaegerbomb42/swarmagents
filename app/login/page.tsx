"use client";

import { useEffect, useState } from "react";
import { Wordmark, HexagonMark } from "@/components/Brand";

interface Me {
  mode: "local" | "server";
  user: { username: string; isAdmin: boolean } | null;
  signup?: "invite" | "open" | "closed";
  needsAdmin?: boolean;
}

const field: React.CSSProperties = {
  padding: "var(--space-3) var(--space-3)",
  fontSize: "var(--type-size-0)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-line-strong)",
  background: "var(--color-bg)",
  color: "var(--color-text)",
  fontFamily: "var(--font-mono)",
};

export default function Login() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
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

  return (
    <main className="login-page">
      <form className="login-form" onSubmit={submit}>
        <div className="login-brand">
          <HexagonMark size={56} state="idle" />
          <Wordmark width={220} />
        </div>
        <h1>{title}</h1>
        {me?.needsAdmin ? (
          <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: "var(--type-size-0)" }}>
            This server has no accounts yet. Use the owner token from the deploy as the invite code; this account becomes the admin.
          </p>
        ) : (
          canSignup && (
            <div role="tablist" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-1)", padding: "var(--space-1)", background: "var(--color-bg-sunken)", borderRadius: "var(--radius-md)" }}>
              {(["signin", "signup"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => {
                    setTab(t);
                    setError("");
                  }}
                  style={{
                    padding: "var(--space-1) 0",
                    fontSize: "var(--type-size-0)",
                    fontWeight: "var(--type-weight-medium)",
                    border: 0,
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                    background: tab === t ? "var(--color-bg-elevated)" : "transparent",
                    color: tab === t ? "var(--color-text)" : "var(--color-text-muted)",
                    boxShadow: tab === t ? "var(--elevation-1)" : undefined,
                  }}
                >
                  {t === "signin" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>
          )
        )}
        <input style={field} autoFocus autoComplete="username" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          style={field}
          type="password"
          autoComplete={tab === "signin" ? "current-password" : "new-password"}
          placeholder={tab === "signin" ? "Password" : "Password (10+ characters)"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {tab === "signup" && needInvite && (
          <input
            style={{ ...field, fontFamily: "var(--font-mono)" }}
            autoComplete="off"
            placeholder={me?.needsAdmin ? "Owner token" : "Invite code"}
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        )}
        {error && <p className="error">{error}</p>}
        <button
          className="btn primary"
          disabled={busy || !username || !password || (tab === "signup" && needInvite && !invite)}
          type="submit"
        >
          {busy ? "…" : tab === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
    </main>
  );
}
