"use client";
import { useCallback, useEffect, useState } from "react";
import "./storage.css";

// Settings → Storage: the per-account quota meter (chats / trajectories / files / browser / other), warnings at 80%
// and 95%, the auto-prune toggle, one-click "clear old chats", per-chat sizes with pin and delete, and a log of
// what was pruned. Server: /api/storage.

type Cat = "chats" | "trajectories" | "files" | "browser" | "other";
interface Chat {
  id: string;
  title: string;
  updatedAt: number;
  bytes: number;
  pinned: boolean;
  busy: boolean;
}
interface Entry {
  at: number;
  kind: string;
  sessionId?: string;
  title?: string;
  freed: number;
  auto: boolean;
}
export interface StorageReport {
  limit: number | null;
  used: number;
  pct: number;
  level: "ok" | "warn" | "critical" | "full";
  message: string | null;
  byCategory: Record<Cat, number>;
  chats: Chat[];
  settings: { autoPrune: boolean; pinned: string[] };
  autoPrune: { startsAt: number; target: number };
  log: Entry[];
  note?: string;
}

const CATS: { id: Cat; label: string }[] = [
  { id: "chats", label: "Chats" },
  { id: "trajectories", label: "Trajectories" },
  { id: "files", label: "Files" },
  { id: "browser", label: "Browser" },
  { id: "other", label: "Other" },
];
const KIND: Record<string, string> = { screenshots: "Screenshots removed", trajectory: "Step detail compacted", chat: "Chat deleted", "clear-old": "Old chat cleared", delete: "Chat deleted" };

export const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);
const ago = (t: number) => {
  const d = Math.floor((Date.now() - t) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/** A one-line warning for the app shell (renders nothing below 80%). */
export function StorageBanner({ onOpen }: { onOpen?: () => void }) {
  const [r, setR] = useState<StorageReport | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/storage").then((x) => (x.ok ? x.json() : null)).then(setR, () => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!r || r.level === "ok" || !r.message) return null;
  return (
    <div className={`stg-banner ${r.level}`} role="alert">
      <span>{r.message}</span>
      {onOpen && (
        <button className="btn" onClick={onOpen}>
          Manage storage
        </button>
      )}
    </div>
  );
}

export function StorageSettings() {
  const [r, setR] = useState<StorageReport | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(30);
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    fetch("/api/storage")
      .then((x) => (x.ok ? x.json() : Promise.reject(new Error(`HTTP ${x.status}`))))
      .then(setR, (e) => setErr(`Couldn't load storage: ${e.message}`));
  }, []);
  useEffect(load, [load]);

  const post = async (body: object, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setErr("");
    try {
      const x = await fetch("/api/storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await x.json();
      if (!x.ok) throw new Error(d.error ?? `HTTP ${x.status}`);
      setR(d);
      setNote(d.note ?? "");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!r)
    return (
      <section className="st-section stg">
        <div className="st-section-head">
          <h3>Storage</h3>
        </div>
        <div className="st-empty">{err || "Loading…"}</div>
      </section>
    );

  const limit = r.limit;
  const chats = [...r.chats].sort((a, b) => b.bytes - a.bytes);
  const old = r.chats.filter((c) => !c.pinned && !c.busy && c.updatedAt < Date.now() - days * 86_400_000);
  const oldBytes = old.reduce((s, c) => s + c.bytes, 0);

  return (
    <section className="st-section stg">
      <div className="st-section-head">
        <h3>Storage</h3>
        <span className="stg-total">
          {fmtBytes(r.used)}
          {limit ? ` of ${fmtBytes(limit)} (${Math.min(100, Math.floor(r.pct * 100))}%)` : " used"}
        </span>
      </div>
      {limit && (
        <div className={`stg-meter ${r.level}`} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={r.used} aria-label="Storage used">
          {CATS.map((c) => (
            <span key={c.id} className={`stg-seg ${c.id}`} style={{ width: `${Math.min(100, (r.byCategory[c.id] / limit) * 100)}%` }} title={`${c.label}: ${fmtBytes(r.byCategory[c.id])}`} />
          ))}
          <i className="stg-tick" style={{ left: "80%" }} />
          <i className="stg-tick" style={{ left: "95%" }} />
        </div>
      )}
      <div className="stg-legend">
        {CATS.map((c) => (
          <span key={c.id}>
            <b className={`stg-dot ${c.id}`} />
            {c.label} {fmtBytes(r.byCategory[c.id])}
          </span>
        ))}
      </div>
      {r.message && <div className={`stg-banner ${r.level}`}>{r.message}</div>}

      <div className="sa-row">
        <span className="sa-label">Auto-prune</span>
        <label className="stg-toggle">
          <input type="checkbox" checked={r.settings.autoPrune} disabled={busy} onChange={(e) => post({ autoPrune: e.target.checked })} />
          <span>
            When you pass {Math.round(r.autoPrune.startsAt * 100)}%, free space down to {Math.round(r.autoPrune.target * 100)}%: screenshots first, then step detail, then the oldest chats. Pinned and running chats are never touched.
          </span>
        </label>
      </div>
      <div className="sa-row">
        <span className="sa-label">Clear old chats</span>
        <select className="input sa-select" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Older than">
          {[7, 30, 90, 365].map((d) => (
            <option key={d} value={d}>
              not used for {d} days
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy || !old.length} onClick={() => post({ action: "clear-old", days }, `Delete ${old.length} chat${old.length === 1 ? "" : "s"} (${fmtBytes(oldBytes)})? This can't be undone.`)}>
          {old.length ? `Delete ${old.length} (${fmtBytes(oldBytes)})` : "Nothing that old"}
        </button>
      </div>
      {(note || err) && <div className={`st-result ${err ? "err" : "ok"}`}>{err || note}</div>}

      <div className="stg-chats">
        {chats.map((c) => (
          <div key={c.id} className="stg-chat">
            <span className="stg-title" title={c.title}>
              {c.title || "Untitled"}
            </span>
            <span className="stg-when">{ago(c.updatedAt)}</span>
            <span className="stg-size">{fmtBytes(c.bytes)}</span>
            <button className={`stg-pin${c.pinned ? " on" : ""}`} aria-pressed={c.pinned} title={c.pinned ? "Pinned: never pruned" : "Pin: never prune this chat"} disabled={busy} onClick={() => post({ pin: c.id, pinned: !c.pinned })}>
              {c.pinned ? "Pinned" : "Pin"}
            </button>
            <button className="stg-del" disabled={busy || c.busy || c.pinned} title={c.busy ? "Running" : c.pinned ? "Unpin to delete" : "Delete this chat"} onClick={() => post({ action: "delete", id: c.id }, `Delete "${c.title}" (${fmtBytes(c.bytes)})? This can't be undone.`)}>
              Delete
            </button>
          </div>
        ))}
        {!chats.length && <div className="st-empty">No chats yet.</div>}
      </div>

      {!!r.log.length && (
        <details className="stg-log">
          <summary>Recently pruned ({r.log.length})</summary>
          {r.log.map((e, i) => (
            <div key={i} className="stg-logrow">
              <span>{new Date(e.at).toLocaleString()}</span>
              <span>
                {KIND[e.kind] ?? e.kind}
                {e.title ? `: ${e.title}` : ""}
                {e.auto ? " (auto)" : ""}
              </span>
              <span>{fmtBytes(e.freed)}</span>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
