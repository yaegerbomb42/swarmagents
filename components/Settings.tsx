"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnType, McpPreset, McpTransport, Preset, ToolPreset } from "@/lib/presets";
import type { PublicConnection, TestResult } from "@/lib/connections";
import { IArrowDown, IArrowUp, IX } from "./icons";
import "./settings.css";

// Settings = every connection in one place: models (LLM providers, failover order), tool keys, MCP connectors.
// One catalog, one form type, one test button. Keys are write-only: the server only ever returns a hint.

interface Catalog {
  llm: Preset[];
  tool: ToolPreset[];
  mcp: McpPreset[];
}
type Row = { k: string; v: string };
interface Draft {
  type: ConnType;
  id?: string;
  preset: string;
  label: string;
  apiKey: string;
  keyHint?: string;
  baseUrl: string;
  vars: Record<string, string>;
  model: string;
  headers: Row[];
  envVar: string;
  testUrl: string;
  transport: McpTransport;
  command: string;
  args: string;
  extraArg: string;
  url: string;
  env: Row[];
  showAdvanced: boolean;
}
type Check = { state: "idle" | "busy" | "ok" | "err"; msg?: string; result?: TestResult };
type CatalogItem = { type: ConnType; id: string; label: string; group: string; blurb?: string; badge?: string };

const TYPE_LABEL: Record<ConnType, string> = { llm: "Models", tool: "Tool keys", mcp: "Connectors" };
const TYPE_HINT: Record<ConnType, string> = {
  llm: "The agent uses the first enabled model and fails over down the list. Drag to reorder. Rate limits are learned from real 429s.",
  tool: "Keys for services the agent's tools call. Each one is also available in the agent's shell as an environment variable.",
  mcp: "MCP servers add tools: local commands or remote URLs. Servers you set up in Claude Code or Claude Desktop appear here automatically.",
};

const toRows = (rec?: Record<string, string>): Row[] => Object.entries(rec ?? {}).map(([k, v]) => ({ k, v }));
const fromRows = (rows: Row[]) => Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
const ago = (t?: number) => {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 86400 * 2 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const SOURCE_LABEL = { swarm: "", "claude-code": "from Claude Code", "claude-desktop": "from Claude Desktop" } as const;

export function Settings({ onClose }: { onClose: () => void }) {
  const [conns, setConns] = useState<PublicConnection[]>([]);
  const [cat, setCat] = useState<Catalog>({ llm: [], tool: [], mcp: [] });
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<"list" | "catalog" | "form">("list");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<ConnType | "all">("all");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [rowTests, setRowTests] = useState<Record<string, Check>>({});
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const d = await (await fetch("/api/connections")).json();
    setConns(d.connections);
    if (d.catalog) setCat(d.catalog);
    setLoaded(true);
    return d as { connections: PublicConnection[]; catalog: Catalog };
  }, []);

  useEffect(() => {
    load().then((d) => {
      if (!d.connections.some((c) => c.type === "llm")) setView("catalog");
    });
    const qs = new URLSearchParams(location.search);
    const ok = qs.get("connected");
    const err = qs.get("connect_error");
    if (ok) setBanner({ ok: true, text: `Connected ${ok.replace(/^mcp:/, "")}.` });
    else if (err) setBanner({ ok: false, text: err === "openrouter" ? "OpenRouter sign-in didn't complete. Try again or paste a key." : err });
  }, [load]);

  // Esc backs out one level: form → catalog/list → close.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (view === "form") setView(draft?.id ? "list" : "catalog");
      else if (view === "catalog" && conns.length) setView("list");
      else onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [view, draft, conns.length, onClose]);

  useEffect(() => {
    if (view === "catalog") setTimeout(() => searchRef.current?.focus(), 30);
  }, [view]);

  const presetOf = (type: ConnType, id: string) => (type === "llm" ? cat.llm.find((p) => p.id === id) : type === "tool" ? cat.tool.find((p) => p.id === id) : cat.mcp.find((p) => p.id === id));
  const llmPreset = draft?.type === "llm" ? cat.llm.find((p) => p.id === draft.preset) : undefined;
  const toolPreset = draft?.type === "tool" ? cat.tool.find((p) => p.id === draft.preset) : undefined;
  const mcpPreset = draft?.type === "mcp" ? cat.mcp.find((p) => p.id === draft.preset) : undefined;

  // ---------- catalog ----------

  const items: CatalogItem[] = useMemo(
    () => [
      ...cat.llm.map((p) => ({ type: "llm" as const, id: p.id, label: p.label, group: p.group === "Connect" ? "One-click" : p.group, blurb: p.blurb, badge: p.oauth ? "Sign in" : p.group === "Local" ? "Local" : undefined })),
      ...cat.tool.map((p) => ({ type: "tool" as const, id: p.id, label: p.label, group: p.group, blurb: p.blurb, badge: p.builtin === "search" ? "web_search" : undefined })),
      ...cat.mcp.map((p) => ({ type: "mcp" as const, id: p.id, label: p.label, group: p.group === "Custom" ? "Custom connector" : `${p.group} connectors`, blurb: p.blurb, badge: p.auth === "oauth" ? "Sign in" : p.transport === "stdio" ? "Local" : undefined })),
    ],
    [cat],
  );
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((i) => (filter === "all" || i.type === filter) && words.every((w) => `${i.label} ${i.group} ${i.blurb ?? ""} ${TYPE_LABEL[i.type]}`.toLowerCase().includes(w)));
  }, [items, q, filter]);

  // ---------- drafts ----------

  const blank = (type: ConnType, preset: string): Draft => ({ type, preset, label: "", apiKey: "", baseUrl: "", vars: {}, model: "", headers: [], envVar: "", testUrl: "", transport: "stdio", command: "", args: "", extraArg: "", url: "", env: [], showAdvanced: false });

  const startNew = (type: ConnType, presetId: string) => {
    const d = blank(type, presetId);
    if (type === "llm") {
      const p = cat.llm.find((x) => x.id === presetId)!;
      d.label = p.label;
      d.baseUrl = p.vars?.length ? "" : p.baseUrl ?? "";
      d.model = p.model;
      d.headers = toRows(p.headers);
      d.vars = Object.fromEntries((p.vars ?? []).map((v) => [v.key, v.default ?? ""]));
    } else if (type === "tool") {
      const p = cat.tool.find((x) => x.id === presetId)!;
      d.label = p.id === "custom-key" ? "" : p.label;
      d.envVar = p.envVar;
    } else {
      const p = cat.mcp.find((x) => x.id === presetId)!;
      d.label = p.id.startsWith("custom") ? "" : p.label;
      d.transport = p.transport;
      d.command = p.command ?? "";
      d.args = (p.args ?? []).join("\n");
      d.url = p.url ?? "";
    }
    setDraft(d);
    setCheck({ state: "idle" });
    setFormError("");
    setView("form");
  };

  const startEdit = (c: PublicConnection) => {
    const d = blank(c.type, c.preset);
    Object.assign(d, { id: c.id, label: c.label, keyHint: c.keyHint });
    if (c.type === "llm") Object.assign(d, { baseUrl: c.baseUrl ?? "", model: c.model ?? "", headers: toRows(c.headers) });
    if (c.type === "tool") Object.assign(d, { envVar: c.envVar ?? "", testUrl: c.testUrl ?? "" });
    if (c.type === "mcp") Object.assign(d, { transport: c.transport ?? "stdio", command: c.command ?? "", args: (c.args ?? []).join("\n"), url: c.url ?? "", env: toRows(c.env), headers: toRows(c.headers) });
    setDraft(d);
    setCheck(c.type === "llm" && c.models?.length ? { state: "idle", result: { ok: true, message: "", models: c.models.map((id) => ({ id })) } } : { state: "idle" });
    setFormError("");
    setView("form");
  };

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  /** The request body for test/save. Unchanged secret fields are omitted so the server keeps them. */
  const toInput = (d: Draft) => {
    const base: Record<string, unknown> = { type: d.type, id: d.id, preset: d.preset, label: d.label || undefined, apiKey: d.apiKey || undefined };
    if (d.type === "llm") {
      const p = cat.llm.find((x) => x.id === d.preset);
      const urlEditable = !!d.id || p?.editableUrl;
      return { ...base, model: d.model, vars: d.vars, baseUrl: urlEditable ? d.baseUrl : undefined, headers: fromRows(d.headers) };
    }
    if (d.type === "tool") return { ...base, envVar: d.envVar, testUrl: d.testUrl };
    const args = d.args.split("\n").map((a) => a.trim()).filter(Boolean);
    if (d.extraArg.trim()) args.push(d.extraArg.trim());
    return d.transport === "stdio"
      ? { ...base, transport: d.transport, command: d.command, args, env: fromRows(d.env) }
      : { ...base, transport: d.transport, url: d.url, headers: fromRows(d.headers) };
  };

  const test = async (d = draft) => {
    if (!d) return;
    setCheck((c) => ({ state: "busy", result: c.result }));
    try {
      const r = await fetch("/api/connections/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toInput(d)) });
      const res = (await r.json()) as TestResult;
      setCheck({ state: res.ok ? "ok" : "err", msg: res.message, result: res.ok ? res : undefined });
      if (res.ok && d.type === "llm" && res.models?.length && !d.model) patch({ model: res.models[0].id });
    } catch (e) {
      setCheck({ state: "err", msg: `Test failed: ${(e as Error).message}` });
    }
  };

  const save = async (then?: (id: string) => void) => {
    if (!draft) return;
    setSaving(true);
    setFormError("");
    try {
      const r = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toInput(draft)) });
      const d = await r.json();
      if (!r.ok) {
        setFormError(d.error ?? "Couldn't save.");
        return;
      }
      setConns(d.connections);
      if (then) then(d.id);
      else {
        setDraft(null);
        setView("list");
        setBanner({ ok: true, text: `Saved ${draft.label || presetOf(draft.type, draft.preset)?.label || "connection"}.` });
      }
    } finally {
      setSaving(false);
    }
  };

  // ---------- list actions ----------

  const post = async (body: unknown, method = "POST", qs = "") => {
    const r = await fetch(`/api/connections${qs}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json();
    if (d.connections) setConns(d.connections);
    if (!r.ok) setBanner({ ok: false, text: d.error ?? "That didn't work." });
  };
  const toggle = (c: PublicConnection) => post({ type: c.type, id: c.id, enabled: !c.enabled });
  const remove = (c: PublicConnection) => {
    const imported = c.source && c.source !== "swarm";
    if (confirm(imported ? `Hide ${c.label}? It stays in your Claude config; Swarm just won't use it.` : `Remove ${c.label}?`)) post(undefined, "DELETE", `?type=${c.type}&id=${encodeURIComponent(c.id)}`);
  };
  const rowTest = async (c: PublicConnection) => {
    setRowTests((t) => ({ ...t, [c.id]: { state: "busy" } }));
    const r = await fetch("/api/connections/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: c.type, id: c.id }) });
    const res = (await r.json()) as TestResult;
    setRowTests((t) => ({ ...t, [c.id]: { state: res.ok ? "ok" : "err", msg: res.message, result: res } }));
  };

  const llms = conns.filter((c) => c.type === "llm");
  const reorder = (ids: string[]) => {
    setConns((cs) => [...ids.map((id) => cs.find((c) => c.id === id)!), ...cs.filter((c) => c.type !== "llm")]);
    post({ order: ids }, "PUT");
  };
  const move = (i: number, d: number) => {
    const ids = llms.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    reorder(ids);
  };
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = llms.map((p) => p.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    setDragId(null);
    reorder(ids);
  };

  // ---------- render ----------

  const title = view === "form" && draft ? (draft.id ? `Edit ${draft.label || "connection"}` : presetOf(draft.type, draft.preset)?.label ?? "Add") : view === "catalog" ? "Add a connection" : "Settings";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal st-modal" role="dialog" aria-label="Settings">
        <div className="modal-head">
          <div className="st-head">
            {view !== "list" && (conns.length > 0 || view === "form") && (
              <button className="st-back" onClick={() => setView(view === "form" && !draft?.id ? "catalog" : "list")} title="Back">
                ‹
              </button>
            )}
            <h2>{title}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <IX />
          </button>
        </div>
        <div className="modal-body">
          {banner && (
            <div className={`st-banner ${banner.ok ? "ok" : "err"}`}>
              <span>{banner.text}</span>
              <button onClick={() => setBanner(null)}>
                <IX />
              </button>
            </div>
          )}

          {view === "list" && loaded && (
            <>
              {(["llm", "tool", "mcp"] as ConnType[]).map((type) => {
                const list = conns.filter((c) => c.type === type);
                return (
                  <section key={type} className="st-section">
                    <div className="st-section-head">
                      <h3>{TYPE_LABEL[type]}</h3>
                      <button
                        className="st-link"
                        onClick={() => {
                          setFilter(type);
                          setQ("");
                          setView("catalog");
                        }}
                      >
                        + Add
                      </button>
                    </div>
                    <p className="st-hint">{TYPE_HINT[type]}</p>
                    {!list.length && <div className="st-empty">{type === "llm" ? "No model yet. Add one to start." : type === "tool" ? "No keys yet. Optional: web search works without one." : "No connectors yet."}</div>}
                    {list.map((c, i) => (
                      <ConnRow
                        key={c.id}
                        c={c}
                        rank={type === "llm" ? i + 1 : undefined}
                        first={i === 0}
                        last={i === list.length - 1}
                        dragging={dragId === c.id}
                        test={rowTests[c.id]}
                        onMove={(d) => move(i, d)}
                        onDragStart={() => type === "llm" && setDragId(c.id)}
                        onDrop={() => type === "llm" && dropOn(c.id)}
                        onToggle={() => toggle(c)}
                        onEdit={() => startEdit(c)}
                        onRemove={() => remove(c)}
                        onTest={() => rowTest(c)}
                      />
                    ))}
                  </section>
                );
              })}
              <button
                className="btn primary st-add"
                onClick={() => {
                  setFilter("all");
                  setQ("");
                  setView("catalog");
                }}
              >
                + Add a model, key or connector
              </button>
            </>
          )}

          {view === "catalog" && (
            <>
              {!llms.length && <p className="sub">Connect at least one model to get started. Everything else is optional.</p>}
              <input ref={searchRef} className="input st-search" placeholder="Search 90+ providers, keys and connectors…" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="st-filters">
                {(["all", "llm", "tool", "mcp"] as const).map((f) => (
                  <button key={f} className={`st-chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
                    {f === "all" ? "All" : TYPE_LABEL[f]}
                  </button>
                ))}
              </div>
              {[...new Set(shown.map((i) => `${i.type}|${i.group}`))].map((key) => {
                const [type, group] = key.split("|");
                const list = shown.filter((i) => i.type === type && i.group === group);
                return (
                  <div key={key}>
                    <div className="group-ttl">
                      {filter === "all" && type !== "mcp" ? `${TYPE_LABEL[type as ConnType]} · ` : ""}
                      {group}
                    </div>
                    <div className="st-grid">
                      {list.map((i) => {
                        const have = conns.some((c) => c.type === i.type && c.preset === i.id && !i.id.startsWith("custom"));
                        return (
                          <button key={`${i.type}-${i.id}`} className="st-card" onClick={() => startNew(i.type, i.id)} title={i.blurb}>
                            <span className="st-card-top">
                              <span className="st-card-name">{i.label}</span>
                              {have ? <span className="st-badge ok">added</span> : i.badge && <span className="st-badge">{i.badge}</span>}
                            </span>
                            {i.blurb && <span className="st-card-blurb">{i.blurb}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {!shown.length && (
                <div className="st-empty">
                  Nothing matches “{q}”. Use{" "}
                  <button className="st-link" onClick={() => startNew("llm", "custom")}>
                    a custom endpoint
                  </button>
                  ,{" "}
                  <button className="st-link" onClick={() => startNew("tool", "custom-key")}>
                    any API key
                  </button>{" "}
                  or{" "}
                  <button className="st-link" onClick={() => startNew("mcp", "custom-http")}>
                    an MCP URL
                  </button>
                  .
                </div>
              )}
            </>
          )}

          {view === "form" && draft && (
            <Form
              draft={draft}
              llm={llmPreset}
              tool={toolPreset}
              mcp={mcpPreset}
              check={check}
              saving={saving}
              error={formError}
              patch={patch}
              onTest={() => test()}
              onSave={() => save()}
              onSaveAndSignIn={() => save((id) => (location.href = `/api/connections/oauth?name=${encodeURIComponent(id)}`))}
              onCancel={() => setView(draft.id ? "list" : "catalog")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- list row ----------

function ConnRow(props: {
  c: PublicConnection;
  rank?: number;
  first: boolean;
  last: boolean;
  dragging: boolean;
  test?: Check;
  onMove(d: number): void;
  onDragStart(): void;
  onDrop(): void;
  onToggle(): void;
  onEdit(): void;
  onRemove(): void;
  onTest(): void;
}) {
  const { c, rank, test } = props;
  const l = c.limits;
  const sub: string[] = [];
  if (c.type === "llm") {
    if (c.keyHint) sub.push(`key ${c.keyHint}`);
    if (l?.throttles) sub.push(`throttled ${l.throttles}× (last ${ago(l.lastThrottleAt)}) · learned ${l.rpm ?? "?"} rpm / ${l.tpm ? Math.round(l.tpm / 1000) + "k" : "?"} tpm`);
    else sub.push("no limits hit yet");
    if (l?.cooldownUntil && l.cooldownUntil > Date.now()) sub.push(`cooling down ${Math.ceil((l.cooldownUntil - Date.now()) / 1000)}s`);
  } else if (c.type === "tool") {
    sub.push(`$${c.envVar}`);
    if (c.keyHint) sub.push(`key ${c.keyHint}`);
  } else {
    sub.push(c.transport === "stdio" ? [c.command, ...(c.args ?? [])].join(" ") : c.url ?? "");
    if (c.source && c.source !== "swarm") sub.push(SOURCE_LABEL[c.source]);
    if (c.oauth === "connected") sub.push("signed in");
  }
  if (c.type === "mcp" && c.status && !c.status.startsWith("failed")) sub.push(c.status);
  const err = c.type === "llm" ? l?.lastError : c.status?.startsWith("failed") ? c.status : undefined;
  return (
    <div
      className={`prov st-row${c.enabled ? "" : " off"}${props.dragging ? " dragging" : ""}`}
      draggable={rank !== undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        props.onDragStart();
      }}
      onDragOver={(e) => rank !== undefined && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
    >
      <div className="prov-top">
        {rank !== undefined && (
          <span className="st-grip" title="Drag to reorder">
            ⋮⋮
          </span>
        )}
        {rank !== undefined && <span className="rank">{rank}</span>}
        <span className="nm">{c.label}</span>
        {c.type === "llm" && <span className="mdl">{c.model}</span>}
        <span className="spacer" />
        {rank !== undefined && (
          <>
            <button className="icon-btn" disabled={props.first} onClick={() => props.onMove(-1)} title="Higher priority">
              <IArrowUp />
            </button>
            <button className="icon-btn" disabled={props.last} onClick={() => props.onMove(1)} title="Lower priority">
              <IArrowDown />
            </button>
          </>
        )}
        <button className="st-mini" onClick={props.onTest} disabled={test?.state === "busy"} title="Check this connection now">
          {test?.state === "busy" ? "…" : "Test"}
        </button>
        {c.oauth === "available" && (
          <a className="st-mini" href={`/api/connections/oauth?name=${encodeURIComponent(c.id)}`} title="Sign in with OAuth">
            Sign in
          </a>
        )}
        <button className={`toggle${c.enabled ? " on" : ""}`} onClick={props.onToggle} title={c.enabled ? "Enabled" : "Disabled"} aria-pressed={c.enabled} />
        <button className="st-mini" onClick={props.onEdit}>
          Edit
        </button>
        <button className="icon-btn" onClick={props.onRemove} title={c.source && c.source !== "swarm" ? "Hide" : "Remove"}>
          <IX />
        </button>
      </div>
      <div className={`prov-meta st-meta${err ? " err" : ""}`}>
        {sub.filter(Boolean).join(" · ")}
        {err && ` · ${err.slice(0, 160)}`}
      </div>
      {test && test.state !== "busy" && (
        <div className={`st-result ${test.state}`}>
          {test.msg}
          {test.result?.tools && test.result.tools.length > 0 && <span className="st-tools"> — {test.result.tools.slice(0, 12).map((t) => t.name).join(", ")}{test.result.tools.length > 12 ? "…" : ""}</span>}
          {test.result?.needsAuth && (
            <a className="st-link" href={`/api/connections/oauth?name=${encodeURIComponent(c.id)}`}>
              {" "}
              Sign in →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- the one form ----------

function Form(props: {
  draft: Draft;
  llm?: Preset;
  tool?: ToolPreset;
  mcp?: McpPreset;
  check: Check;
  saving: boolean;
  error: string;
  patch(p: Partial<Draft>): void;
  onTest(): void;
  onSave(): void;
  onSaveAndSignIn(): void;
  onCancel(): void;
}) {
  const { draft: d, llm, tool, mcp, check, patch } = props;
  const [modelQ, setModelQ] = useState("");
  const models = check.result?.models ?? [];
  const filtered = models.filter((m) => m.id.toLowerCase().includes((modelQ || "").toLowerCase())).slice(0, 80);
  const keyUrl = llm?.keyUrl ?? tool?.keyUrl ?? mcp?.keyUrl;
  const blurb = llm?.blurb ?? tool?.blurb ?? mcp?.blurb;

  const needsKey = d.type === "llm" ? llm?.needsKey !== false : d.type === "tool" ? true : mcp?.auth === "key" || mcp?.auth === "optional-key";
  const keyOptional = d.type === "llm" ? !llm?.needsKey : d.type === "mcp" ? mcp?.auth === "optional-key" : false;
  const showKey = needsKey || d.type === "llm";
  const urlEditable = d.type === "llm" && (!!d.id || llm?.editableUrl);
  const isOAuthMcp = d.type === "mcp" && d.transport !== "stdio" && (mcp?.auth === "oauth" || mcp?.id === "custom-http");
  const isCustomMcp = mcp?.id?.startsWith("custom") || !mcp || !!d.id;
  const autoTest = () => (d.apiKey || d.id || !needsKey) && props.onTest();

  return (
    <div className="st-form">
      {blurb && <p className="sub">{blurb}</p>}

      {llm?.oauth && !d.id && (
        <>
          <a className="btn primary st-oauth" href="/api/connect/openrouter">
            Connect your {llm.label} account
          </a>
          <div className="or">or paste a key</div>
        </>
      )}

      {(d.type === "tool" ? tool?.id === "custom-key" : true) && (
        <div className="field">
          <label>Name</label>
          <input className="input" value={d.label} placeholder={llm?.label ?? mcp?.label ?? "My API"} onChange={(e) => patch({ label: e.target.value })} />
        </div>
      )}

      {d.type === "llm" && !d.id && llm?.vars?.map((v) => (
        <div className="field" key={v.key}>
          <label>{v.label}</label>
          <input className="input mono" placeholder={v.placeholder} value={d.vars[v.key] ?? ""} onChange={(e) => patch({ vars: { ...d.vars, [v.key]: e.target.value } })} onBlur={autoTest} />
          <span className="st-help">{llm.baseUrl?.replace(`{${v.key}}`, d.vars[v.key] || `{${v.key}}`)}</span>
        </div>
      ))}

      {urlEditable && (
        <div className="field">
          <label>Base URL</label>
          <input className="input mono" placeholder={llm?.kind === "anthropic" ? "https://…  (we add /v1/messages)" : "https://…/v1"} value={d.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} onBlur={autoTest} />
        </div>
      )}

      {d.type === "tool" && (
        <div className="field">
          <label>Shell variable</label>
          <input className="input mono" placeholder="MY_API_KEY" value={d.envVar} disabled={tool?.id !== "custom-key"} onChange={(e) => patch({ envVar: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} />
          <span className="st-help">The agent can use it as ${d.envVar || "MY_API_KEY"} in commands.</span>
        </div>
      )}

      {d.type === "mcp" && isCustomMcp && (
        <div className="field">
          <label>Transport</label>
          <div className="st-seg">
            {(["stdio", "http", "sse"] as const).map((t) => (
              <button key={t} className={d.transport === t ? "on" : ""} onClick={() => patch({ transport: t })}>
                {t === "stdio" ? "Local command" : t === "http" ? "Streamable HTTP" : "SSE"}
              </button>
            ))}
          </div>
        </div>
      )}

      {d.type === "mcp" && d.transport === "stdio" && (
        <>
          <div className="field">
            <label>Command</label>
            <input className="input mono" placeholder="npx" value={d.command} onChange={(e) => patch({ command: e.target.value })} disabled={!isCustomMcp} />
          </div>
          <div className="field">
            <label>Arguments (one per line)</label>
            <textarea className="input mono st-area" rows={Math.min(6, Math.max(2, d.args.split("\n").length))} value={d.args} onChange={(e) => patch({ args: e.target.value })} disabled={!isCustomMcp} />
          </div>
          {mcp?.argPrompt && !d.id && (
            <div className="field">
              <label>{mcp.argPrompt}</label>
              <input className="input mono" value={d.extraArg} onChange={(e) => patch({ extraArg: e.target.value })} placeholder={mcp.id === "filesystem" ? "/Users/you/Projects" : ""} />
            </div>
          )}
        </>
      )}

      {d.type === "mcp" && d.transport !== "stdio" && (
        <div className="field">
          <label>Server URL</label>
          <input className="input mono" placeholder="https://example.com/mcp" value={d.url} onChange={(e) => patch({ url: e.target.value })} disabled={!isCustomMcp} />
        </div>
      )}

      {showKey && (
        <div className="field">
          <label>
            {d.type === "mcp" ? "Token" : "API key"}
            {keyOptional && <span className="st-opt"> optional</span>}
            {keyUrl && (
              <a href={keyUrl} target="_blank" rel="noreferrer" className="st-get">
                get one ↗
              </a>
            )}
          </label>
          <input className="input" type="password" autoComplete="off" placeholder={d.keyHint ? `Saved (${d.keyHint}). Leave blank to keep it.` : "Paste key"} value={d.apiKey} onChange={(e) => patch({ apiKey: e.target.value })} onBlur={autoTest} />
        </div>
      )}

      {d.type === "llm" && (
        <div className="field">
          <label>Model</label>
          <input className="input mono" value={d.model} placeholder={llm?.noModelList ? "model id" : "Test to list models"} onChange={(e) => (patch({ model: e.target.value }), setModelQ(e.target.value))} />
          {models.length > 1 && (
            <div className="st-models">
              {filtered.map((m) => (
                <button key={m.id} className={m.id === d.model ? "on" : ""} onClick={() => (patch({ model: m.id }), setModelQ(""))}>
                  {m.id}
                  {m.context ? <span>{Math.round(m.context / 1000)}k</span> : null}
                </button>
              ))}
              {!filtered.length && <div className="st-help">No listed model matches. Custom ids are fine.</div>}
            </div>
          )}
        </div>
      )}

      {d.type === "tool" && tool?.id === "custom-key" && (
        <div className="field">
          <label>
            Check URL <span className="st-opt">optional</span>
          </label>
          <input className="input mono" placeholder="https://api.example.com/v1/me (GET with Bearer key)" value={d.testUrl} onChange={(e) => patch({ testUrl: e.target.value })} />
        </div>
      )}

      {(d.type === "llm" || d.type === "mcp") && (
        <div className="st-adv">
          <button className="st-link" onClick={() => patch({ showAdvanced: !d.showAdvanced })}>
            {d.showAdvanced ? "▾" : "▸"} {d.type === "mcp" && d.transport === "stdio" ? "Environment variables" : "Extra headers"}
            {(d.type === "mcp" && d.transport === "stdio" ? d.env : d.headers).length ? ` (${(d.type === "mcp" && d.transport === "stdio" ? d.env : d.headers).length})` : ""}
          </button>
          {d.showAdvanced && (
            <Rows
              rows={d.type === "mcp" && d.transport === "stdio" ? d.env : d.headers}
              onChange={(rows) => patch(d.type === "mcp" && d.transport === "stdio" ? { env: rows } : { headers: rows })}
              keyPlaceholder={d.type === "mcp" && d.transport === "stdio" ? "VAR_NAME" : "Header-Name"}
              help={d.type === "llm" ? "Use {key} to insert the API key, e.g. api-key: {key}." : "Values shown as •••• are saved secrets; leave them to keep them."}
            />
          )}
        </div>
      )}

      {check.state !== "idle" && check.state !== "busy" && (
        <div className={`st-result ${check.state}`}>
          {check.msg}
          {check.result?.tools && check.result.tools.length > 0 && (
            <div className="st-toollist">
              {check.result.tools.map((t) => (
                <span key={t.name} title={t.description}>
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {d.type === "mcp" && check.state === "err" && !check.result && isOAuthMcp && <div className="st-help">This server needs a sign-in. Use “Save & sign in”.</div>}
      {props.error && <div className="st-result err">{props.error}</div>}

      <div className="btn-row st-actions">
        <span className="st-status">{check.state === "busy" ? (d.type === "mcp" && d.transport === "stdio" ? "Starting server… (first npx/uvx run can take a minute)" : "Checking…") : ""}</span>
        <button className="btn" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="btn" onClick={props.onTest} disabled={check.state === "busy"}>
          Test
        </button>
        {isOAuthMcp && (
          <button className="btn" onClick={props.onSaveAndSignIn} disabled={props.saving}>
            Save & sign in
          </button>
        )}
        <button className="btn primary" onClick={props.onSave} disabled={props.saving || (d.type === "llm" && !d.model)}>
          {props.saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Rows({ rows, onChange, keyPlaceholder, help }: { rows: Row[]; onChange(r: Row[]): void; keyPlaceholder: string; help: string }) {
  const set = (i: number, p: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="st-rows">
      {rows.map((r, i) => (
        <div className="st-kv" key={i}>
          <input className="input mono" placeholder={keyPlaceholder} value={r.k} onChange={(e) => set(i, { k: e.target.value })} />
          <input className="input mono" placeholder="value" value={r.v} onChange={(e) => set(i, { v: e.target.value })} />
          <button className="icon-btn" onClick={() => onChange(rows.filter((_, j) => j !== i))} title="Remove">
            <IX />
          </button>
        </div>
      ))}
      <button className="st-link" onClick={() => onChange([...rows, { k: "", v: "" }])}>
        + Add
      </button>
      <div className="st-help">{help}</div>
    </div>
  );
}
