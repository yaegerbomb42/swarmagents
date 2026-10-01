"use client";

import { useState } from "react";

export default function Login() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (r.ok) {
      const next = new URLSearchParams(location.search).get("next") ?? "/";
      location.replace(next.startsWith("/") && !next.startsWith("//") ? next : "/");
      return;
    }
    setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Sign-in failed.");
    setBusy(false);
  }

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--sans)" }}>
      <form
        onSubmit={submit}
        style={{ width: "100%", maxWidth: 360, display: "grid", gap: 12, padding: 24, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "var(--radius)", boxShadow: "var(--shadow)" }}
      >
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Swarm</h1>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>This agent can run commands on its server. Enter the access token to continue.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Access token"
          style={{ padding: "10px 12px", fontSize: 15, borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--sunken)", color: "var(--text)", fontFamily: "var(--mono)" }}
        />
        {error && <p style={{ margin: 0, color: "var(--err)", fontSize: 13 }}>{error}</p>}
        <button
          disabled={busy || !token}
          style={{ padding: "10px 12px", fontSize: 15, fontWeight: 600, borderRadius: 8, border: 0, background: "var(--accent)", color: "var(--accent-text)", cursor: busy ? "wait" : "pointer", opacity: busy || !token ? 0.6 : 1 }}
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
