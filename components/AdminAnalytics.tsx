"use client";
import { useCallback, useEffect, useState } from "react";
import { fmtBytes } from "./StorageSettings";
import "./storage.css";
import { AgentIcon } from "./agent-icons";

// Admin-only Analytics (Settings). Renders nothing unless /api/me says the signed-in user is an admin, and the API
// itself answers 403 to everyone else. Live users (seen in the last 5 minutes), sign-ups (total + per day), running
// agent work, and storage in total and per user, with the per-user quota editable.

interface U {
  id: string;
  username: string;
  email: string | null;
  isAdmin: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  live: boolean;
  tasksRunning: number;
  tasksQueued: number;
  chatsRunning: number;
  storage: { used: number; limit: number | null; custom: boolean };
}
interface A {
  liveUsers: number;
  liveWindowMin: number;
  totalSignups: number;
  signupsPerDay: { date: string; n: number }[];
  running: { tasks: number; queued: number; chats: number };
  storage: { total: number };
  users: U[];
}

const since = (t: number | null) => {
  if (!t) return "never";
  const m = Math.floor((Date.now() - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};

function Chart({ data }: { data: { date: string; n: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  const w = 100 / data.length;
  return (
    <svg className="adm-chart" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Sign-ups per day, last 30 days">
      {data.map((d, i) => (
        <rect key={d.date} x={i * w + w * 0.15} width={w * 0.7} y={40 - (d.n / max) * 36} height={(d.n / max) * 36 || 0.4}>
          <title>{`${d.date}: ${d.n}`}</title>
        </rect>
      ))}
    </svg>
  );
}

export function AdminAnalytics() {
  const [admin, setAdmin] = useState(false);
  const [a, setA] = useState<A | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => setAdmin(m?.mode === "server" && !!m?.user?.isAdmin), () => {});
  }, []);

  const load = useCallback(() => {
    fetch("/api/admin/analytics")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setA, (e) => setErr(e.message));
  }, []);
  useEffect(() => {
    if (!admin) return;
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [admin, load]);

  const setQuota = async (u: U, v: string) => {
    const quotaMB = v === "default" ? null : Number(v);
    const r = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: u.id, quotaMB }) });
    if (!r.ok) setErr((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    load();
  };

  const remove = async (u: U) => {
    const typed = window.prompt(`Delete ${u.username} and everything they stored (${fmtBytes(u.storage.used)}: chats, files, keys)? Their running work is stopped and they are signed out. This can't be undone.\n\nType the username to confirm:`);
    if (typed === null) return;
    setErr("");
    const r = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: u.id, action: "delete", confirm: typed.trim() }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setErr(d.error ?? `HTTP ${r.status}`);
    else setNote(`Deleted ${d.username}: ${d.chats} chats, ${fmtBytes(d.freed)} freed.`);
    load();
  };

  if (!admin) return null;
  return (
    <section className="st-section adm">
      <div className="st-section-head">
        <h3 className="agent-icon-h"><AgentIcon name="observer" />Analytics</h3>
        <span className="stg-total">admin only</span>
      </div>
      {!a ? (
        <div className="st-empty">{err || "Loading…"}</div>
      ) : (
        <>
          <div className="adm-tiles">
            <div>
              <b>{a.liveUsers}</b>
              <span>live now (last {a.liveWindowMin} min)</span>
            </div>
            <div>
              <b>{a.totalSignups}</b>
              <span>sign-ups</span>
            </div>
            <div>
              <b>{a.running.tasks + a.running.chats}</b>
              <span>
                running ({a.running.tasks} tasks, {a.running.chats} chats; {a.running.queued} queued)
              </span>
            </div>
            <div>
              <b>{fmtBytes(a.storage.total)}</b>
              <span>stored, all users</span>
            </div>
          </div>
          <div className="adm-chart-wrap">
            <span className="st-hint">Sign-ups per day, last 30 days</span>
            <Chart data={a.signupsPerDay} />
          </div>
          {(err || note) && <div className={`st-result ${err ? "err" : "ok"}`}>{err || note}</div>}
          <div className="stg-chats">
            {a.users.map((u) => (
              <div key={u.id} className="adm-user">
                <span className="stg-title" title={u.email ?? u.username}>
                  <i className={`adm-live${u.live ? " on" : ""}`} />
                  {u.username}
                  {u.isAdmin ? " (admin)" : ""}
                </span>
                <span className="stg-when">{since(u.lastSeenAt)}</span>
                <span className="stg-when">{u.tasksRunning + u.chatsRunning} running</span>
                <span className="stg-size">
                  {fmtBytes(u.storage.used)}
                  {u.storage.limit ? ` / ${fmtBytes(u.storage.limit)}` : ""}
                </span>
                <select className="input adm-quota" aria-label={`Storage quota for ${u.username}`} value={u.storage.custom && u.storage.limit ? String(Math.round(u.storage.limit / 1024 ** 2)) : "default"} onChange={(e) => setQuota(u, e.target.value)}>
                  <option value="default">default</option>
                  {[256, 512, 1024, 2048, 5120, 10240].map((mb) => (
                    <option key={mb} value={mb}>
                      {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                    </option>
                  ))}
                  {u.storage.custom && u.storage.limit && ![256, 512, 1024, 2048, 5120, 10240].includes(Math.round(u.storage.limit / 1024 ** 2)) && <option value={String(Math.round(u.storage.limit / 1024 ** 2))}>{fmtBytes(u.storage.limit)}</option>}
                </select>
                {u.isAdmin ? (
                  <span className="adm-del-gap" />
                ) : (
                  <button className="stg-del" title={`Delete ${u.username} and all their data`} onClick={() => remove(u)}>
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
