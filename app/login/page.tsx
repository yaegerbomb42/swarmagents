"use client";

import { useEffect, useState } from "react";

interface Me {
  mode: "local" | "server";
  user: { username: string; isAdmin: boolean } | null;
  signup?: "invite" | "open" | "closed";
  needsAdmin?: boolean;
}

const field: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 15,
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  background: "var(--sunken)",
  color: "var(--text)",
  fontFamily: "inherit",
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
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--sans)" }}>
      <form
        onSubmit={submit}
        style={{ width: "100%", maxWidth: 380, display: "grid", gap: 12, padding: 24, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "var(--radius)", boxShadow: "var(--shadow)" }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Swarm</h1>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{title}</span>
        </div>
        {me?.needsAdmin ? (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>This server has no accounts yet. Use the owner token from the deploy as the invite code; this account becomes the admin.</p>
        ) : (
          canSignup && (
            <div role="tablist" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: 3, background: "var(--sunken)", borderRadius: 8 }}>
              {(["signin", "signup"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => (setTab(t), setError(""))}
                  style={{ padding: "6px 0", fontSize: 13, fontWeight: 500, border: 0, borderRadius: 6, cursor: "pointer", background: tab === t ? "var(--panel)" : "transparent", color: tab === t ? "var(--text)" : "var(--muted)", boxShadow: tab === t ? "var(--shadow)" : undefined }}
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
          <input style={{ ...field, fontFamily: "var(--mono)" }} autoComplete="off" placeholder={me?.needsAdmin ? "Owner token" : "Invite code"} value={invite} onChange={(e) => setInvite(e.target.value)} />
        )}
        {error && <p style={{ margin: 0, color: "var(--err)", fontSize: 13 }}>{error}</p>}
        <button
          disabled={busy || !username || !password || (tab === "signup" && needInvite && !invite)}
          style={{ padding: "10px 12px", fontSize: 15, fontWeight: 600, borderRadius: 8, border: 0, background: "var(--accent)", color: "var(--accent-text)", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "…" : tab === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
    </main>
  );
}
