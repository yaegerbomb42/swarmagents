"use client";
import { useEffect, useState } from "react";
import type { Preset } from "@/lib/presets";
import type { ProviderKind, PublicProvider } from "@/lib/types";
import { IArrowDown, IArrowUp, IX } from "./icons";

interface Draft {
  id?: string;
  kind: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
}

const ago = (t?: number) => {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 86400 * 2 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

export function Settings({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [q, setQ] = useState("");
  const [check, setCheck] = useState<{ state: "idle" | "busy" | "ok" | "err"; msg?: string }>({ state: "idle" });

  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((d) => {
        setProviders(d.providers);
        setPresets(d.presets);
        if (!d.providers.length) setDraft({ kind: "anthropic", apiKey: "", baseUrl: "", model: d.presets[0].model });
      });
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const call = async (method: string, body?: unknown, q = "") => {
    const r = await fetch(`/api/providers${q}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    setProviders((await r.json()).providers);
  };

  const preset = draft ? presets.find((p) => p.kind === draft.kind) : undefined;

  const verify = async () => {
    if (!draft) return;
    setCheck({ state: "busy" });
    setModels([]);
    try {
      const r = await fetch("/api/providers/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const d: { ok?: boolean; models?: { id: string }[]; error?: string } | null = await r.json().catch(() => null);
      if (!r.ok || !d?.ok || !Array.isArray(d.models)) {
        setCheck({ state: "err", msg: d?.error || `Connection test failed (HTTP ${r.status}).` });
        return;
      }
      setModels(d.models);
      if (d.models.length && !d.models.some((m) => m.id === draft.model)) setDraft((x) => (x && !x.model ? { ...x, model: d.models![0].id } : x));
      setCheck({ state: "ok", msg: `Connected · ${d.models.length} models` });
    } catch (e) {
      setCheck({ state: "err", msg: e instanceof Error ? `Connection test failed: ${e.message}` : "Connection test failed. Check your network and try again." });
    }
  };

  const save = async () => {
    if (!draft) return;
    await call("POST", { ...draft, baseUrl: draft.baseUrl || preset?.baseUrl });
    setDraft(null);
    setModels([]);
    setCheck({ state: "idle" });
  };

  const move = (i: number, d: number) => {
    const ids = providers.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    call("PUT", { order: ids });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Providers</h2>
          <button className="icon-btn" onClick={onClose}>
            <IX />
          </button>
        </div>
        <div className="modal-body">
          <p className="sub">The agent uses the first provider and fails over down the list. It learns rate limits as it goes, so there's nothing to configure.</p>

          {providers.map((p, i) => (
            <div key={p.id} className="prov" style={{ opacity: p.enabled ? 1 : 0.55 }}>
              <div className="prov-top">
                <span className="rank">{i + 1}</span>
                <span className="nm">{p.label}</span>
                <span className="mdl">{p.model}</span>
                <span className="spacer" />
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Higher priority">
                  <IArrowUp />
                </button>
                <button className="icon-btn" disabled={i === providers.length - 1} onClick={() => move(i, 1)} title="Lower priority">
                  <IArrowDown />
                </button>
                <button className={`toggle${p.enabled ? " on" : ""}`} onClick={() => call("POST", { id: p.id, enabled: !p.enabled })} title={p.enabled ? "Enabled" : "Disabled"} />
                <button
                  className="btn"
                  style={{ padding: "4px 10px", fontSize: 12.5 }}
                  onClick={() => {
                    setDraft({ id: p.id, kind: p.kind, apiKey: "", baseUrl: p.baseUrl ?? "", model: p.model });
                    setModels([]);
                    setCheck({ state: "idle" });
                  }}
                >
                  Edit
                </button>
                <button className="icon-btn" onClick={() => confirm(`Remove ${p.label}?`) && call("DELETE", undefined, `?id=${p.id}`)} title="Remove">
                  <IX />
                </button>
              </div>
              <div className={`prov-meta${p.limits.lastError ? " err" : ""}`} style={{ paddingLeft: 26 }}>
                {p.keyHint && `key ${p.keyHint}`}
                {p.limits.throttles > 0 &&
                  ` · throttled ${p.limits.throttles}× (last ${ago(p.limits.lastThrottleAt)}) · learned ${p.limits.rpm ?? "?"} rpm / ${p.limits.tpm ? Math.round(p.limits.tpm / 1000) + "k" : "?"} tpm`}
                {!p.limits.throttles && " · no limits hit yet"}
                {p.limits.lastError && ` · ${p.limits.lastError.slice(0, 140)}`}
              </div>
            </div>
          ))}

          {!draft && (
            <button className="btn" style={{ width: "100%", marginTop: 6 }} onClick={() => setDraft({ kind: "anthropic", apiKey: "", baseUrl: "", model: presets[0]?.model ?? "" })}>
              + Add provider
            </button>
          )}

          {draft && (
            <div className="prov" style={{ marginTop: 14, padding: 16 }}>
              {!draft.id && (
                <>
                  <input className="input" placeholder="Search providers…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
                  {[...new Set(presets.map((p) => p.group))].map((group) => {
                    const items = presets.filter((p) => p.group === group && p.label.toLowerCase().includes(q.toLowerCase()));
                    if (!items.length) return null;
                    return (
                      <div key={group}>
                        <div className="group-ttl">{group === "Connect" ? "One-click" : group}</div>
                        <div className="kinds">
                          {items.map((p) => (
                            <button
                              key={p.kind}
                              className={`kind${draft.kind === p.kind ? " on" : ""}`}
                              onClick={() => {
                                setDraft({ kind: p.kind, apiKey: "", baseUrl: p.baseUrl ?? "", model: p.model });
                                setModels([]);
                                setCheck({ state: "idle" });
                              }}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
              {preset?.oauth && !draft.id && (
                <a className="btn primary" href="/api/connect/openrouter" style={{ display: "block", textAlign: "center", textDecoration: "none", marginBottom: 12 }}>
                  Connect your {preset.label} account
                </a>
              )}
              {preset?.oauth && !draft.id && <div className="or">or paste a key</div>}
              {preset?.needsKey !== false && (
                <div className="field">
                  <label>
                    API key{" "}
                    {preset?.keyUrl && (
                      <a href={preset.keyUrl} target="_blank" rel="noreferrer" style={{ color: "var(--run)", textDecoration: "none", marginLeft: 6 }}>
                        get one ↗
                      </a>
                    )}
                  </label>
                  <input className="input" type="password" placeholder={draft.id ? "Leave blank to keep current key" : "sk-…"} value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} onBlur={() => (draft.apiKey || draft.id) && verify()} />
                </div>
              )}
              {(preset?.group === "Local" || preset?.group === "Custom") && (
                <div className="field">
                  <label>Base URL</label>
                  <input className="input" placeholder="https://…/v1" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} onBlur={verify} />
                </div>
              )}
              <div className="field">
                <label>Model</label>
                <input className="input" list="models" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} style={{ fontFamily: "var(--mono)", fontSize: 13 }} />
                <datalist id="models">
                  {models.map((m) => (
                    <option key={m.id} value={m.id} />
                  ))}
                </datalist>
              </div>
              <div className="btn-row">
                <span style={{ fontSize: 12.5, marginRight: "auto", color: check.state === "err" ? "var(--err)" : check.state === "ok" ? "var(--ok)" : "var(--muted)" }}>
                  {check.state === "busy" ? "Checking…" : check.msg?.slice(0, 160)}
                </span>
                <button className="btn" onClick={() => (setDraft(null), setCheck({ state: "idle" }))}>
                  Cancel
                </button>
                <button className="btn" onClick={verify} disabled={check.state === "busy"}>
                  Test
                </button>
                <button className="btn primary" onClick={save} disabled={!draft.model || (!draft.id && preset?.needsKey && !draft.apiKey)}>
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
