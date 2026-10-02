"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "./browser-live.css";

// The "watch live" panel: CDP screencast frames from /api/browser/stream plus take-over controls
// from /api/browser/control. It renders next to the chat and appears on its own when the agent
// opens a browser for the task.

export type LiveTab = { index: number; url: string; title?: string; active: boolean };
export type LiveStatus = {
  key: string;
  live: boolean;
  controller?: "agent" | "user";
  paused?: boolean;
  url?: string;
  tabs?: LiveTab[];
  pointer?: { x: number; y: number; label?: string } | null;
  downloads?: { name: string; bytes: number; path: string; at: number }[];
  startedAt?: number;
  note?: string;
};

type Frame = { data: string; ts: number; n: number };

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return { host: u.host, rest: u.pathname + u.search, secure: u.protocol === "https:" };
  } catch {
    return { host: "", rest: url, secure: false };
  }
};

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

/** Map a browser event's modifier flags to CDP bits (1 alt, 2 ctrl, 4 meta, 8 shift). */
function modifiersOf(e: KeyboardEvent | MouseEvent) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** Poll just enough to know whether this task has a live browser (so the panel can auto-appear). */
export function useBrowserLive(sessionId?: string) {
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setLive(false);
      setStatus(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/browser/control?session=${encodeURIComponent(sessionId)}`);
        if (!r.ok) {
          if (alive) setLive(false);
          return;
        }
        const d = (await r.json()) as { status?: LiveStatus };
        if (!alive) return;
        setStatus(d.status ?? null);
        setLive(!!d.status?.live);
      } catch {
        // A transient network error must not tear the panel down.
      }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId]);
  return { live, status };
}

export function BrowserLive({ sessionId, onClose }: { sessionId: string; onClose?: () => void }) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [delay, setDelay] = useState<number | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewport = useRef({ w: 1280, h: 860 });
  const imgRef = useRef<HTMLImageElement>(null);
  const lastSent = useRef(0);

  const inControl = status?.controller === "user";

  // ---- stream ----
  useEffect(() => {
    setFrame(null);
    setLog([]);
    setClosed(null);
    setError(null);
    const es = new EventSource(`/api/browser/stream?session=${encodeURIComponent(sessionId)}`);
    es.onmessage = (m) => {
      const d = JSON.parse(m.data) as
        | { type: "hello"; status: LiveStatus }
        | { type: "frame"; data: string; ts: number; n: number }
        | { type: "event"; event: { type: string; text?: string; name?: string; reason?: string; url?: string; controller?: string } }
        | { type: "closed"; reason: string };
      if (d.type === "hello") {
        setStatus(d.status);
      } else if (d.type === "frame") {
        setFrame({ data: d.data, ts: d.ts, n: d.n });
        setDelay(d.n ? Math.max(0, Date.now() - d.ts) : null);
      } else if (d.type === "event") {
        const e = d.event;
        const line =
          e.type === "download"
            ? `Downloaded ${e.text ?? e.name ?? "a file"}`
            : e.type === "tab"
              ? `Tab ${e.text ?? ""} ${e.url ?? ""}`.trim()
              : e.type === "control"
                ? `Control: ${e.controller}`
                : e.type === "notice"
                  ? (e.text ?? "notice")
                  : `Action: ${e.name ?? e.type}`;
        setLog((l) => [...l.slice(-40), line]);
      } else if (d.type === "closed") {
        setClosed(d.reason);
      }
    };
    es.onerror = () => setError("Live stream disconnected — retrying.");
    return () => es.close();
  }, [sessionId]);

  // ---- control ----
  const post = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const r = await fetch("/api/browser/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: sessionId, ...body }),
        });
        const d = (await r.json()) as { status?: LiveStatus; error?: string };
        if (!r.ok) setError(d.error ?? `Control failed (${r.status})`);
        else {
          setError(null);
          if (d.status) setStatus(d.status);
        }
        return d.status ?? null;
      } catch {
        setError("Control request failed.");
        return null;
      }
    },
    [sessionId],
  );

  const takeOver = () => post({ takeOver: true });
  const handBack = () => post({ handBack: true });
  const pause = () => post({ cmd: { paused: true } });
  const resume = () => post({ cmd: { paused: false } });
  const stop = () => post({ cmd: { stop: true } });

  // ---- input forwarding ----
  const toPage = (e: { clientX: number; clientY: number }) => {
    const el = imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * viewport.current.w;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * viewport.current.h;
    return { x, y };
  };

  const sendInput = useCallback(
    (input: Record<string, unknown>, throttle = false) => {
      if (throttle) {
        const now = Date.now();
        if (now - lastSent.current < 40) return;
        lastSent.current = now;
      }
      void fetch("/api/browser/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionId, input }),
        keepalive: true,
      }).catch(() => {});
    },
    [sessionId],
  );

  useEffect(() => {
    if (!inControl) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      const action = e.type === "keydown" ? "down" : "up";
      sendInput({ kind: "key", action, key: e.key, code: e.code, text: e.key.length === 1 ? e.key : undefined, modifiers: modifiersOf(e) });
      if (e.type === "keydown" && e.key.length === 1 && !e.ctrlKey && !e.metaKey) sendInput({ kind: "key", action: "char", key: e.key, text: e.key });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [inControl, sendInput]);

  const h = hostOf(status?.url ?? "");
  const controlLabel = closed ? "Closed" : inControl ? "You have control" : status?.paused ? "Paused" : "Agent in control";

  return (
    <aside className="bl" aria-label="Live browser">
      <div className="bl-bar">
        <span className={`bl-dot${closed ? " off" : inControl ? " user" : " agent"}`} />
        <span className="bl-who">{controlLabel}</span>
        <span className="bl-spacer" />
        {delay != null && !closed && (
          <span className="bl-lag" title="Screencast frame delay">
            {delay}ms
          </span>
        )}
        {onClose && (
          <button className="bl-icon" onClick={onClose} title="Hide the live view">
            ✕
          </button>
        )}
      </div>

      <div className="bl-url" title={status?.url ?? ""}>
        {h.host ? (
          <>
            {h.secure && <span className="bl-lock" aria-label="secure">🔒</span>}
            <span className="bl-host">{h.host}</span>
            <span className="bl-path">{h.rest}</span>
          </>
        ) : (
          <span className="bl-path">{closed ? "Browser closed" : "Waiting for the agent to open a page…"}</span>
        )}
      </div>

      {!!status?.tabs?.length && (
        <div className="bl-tabs">
          {status.tabs.map((t) => (
            <span key={t.index} className={`bl-tab${t.active ? " on" : ""}`} title={t.url}>
              {t.index}. {hostOf(t.url).host || t.url || "new tab"}
            </span>
          ))}
        </div>
      )}

      <div className={`bl-view${inControl ? " driving" : ""}`}>
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame.data}`}
            alt="Live browser"
            draggable={false}
            onLoad={(e) => {
              // The screencast is the 1280x860 viewport scaled to the panel; remember its real size for mapping.
              const el = e.currentTarget;
              viewport.current = { w: el.naturalWidth || 1280, h: el.naturalHeight || 860 };
            }}
            onMouseMove={(e) => inControl && sendInput({ kind: "mouse", action: "move", ...toPage(e) }, true)}
            onMouseDown={(e) => inControl && sendInput({ kind: "mouse", action: "down", button: e.button + 1, ...toPage(e) })}
            onMouseUp={(e) => inControl && sendInput({ kind: "mouse", action: "up", button: e.button + 1, ...toPage(e) })}
            onWheel={(e) => inControl && sendInput({ kind: "mouse", action: "wheel", deltaY: e.deltaY, ...toPage(e) })}
            onContextMenu={(e) => e.preventDefault()}
          />
        ) : (
          <div className="bl-idle">
            <span className="bl-spin" />
            {closed ?? "Waiting for the first frame…"}
          </div>
        )}
        {status?.pointer && (
          <span
            className="bl-cursor"
            style={{
              left: `${(status.pointer.x / viewport.current.w) * 100}%`,
              top: `${(status.pointer.y / viewport.current.h) * 100}%`,
            }}
          >
            {status.pointer.label ? <em>{status.pointer.label}</em> : <i />}
          </span>
        )}
      </div>

      <div className="bl-controls">
        {!closed && !inControl && (
          <button className="bl-btn primary" onClick={takeOver} title="Type and click in the browser yourself (logins, 2FA, captchas)">
            Take over
          </button>
        )}
        {!closed && inControl && (
          <button className="bl-btn" onClick={handBack} title="Give the browser back to the agent">
            Hand back
          </button>
        )}
        {!closed && !status?.paused && (
          <button className="bl-btn" onClick={pause} title="Pause the agent's browser actions">
            Pause
          </button>
        )}
        {!closed && status?.paused && (
          <button className="bl-btn" onClick={resume} title="Let the agent continue">
            Resume
          </button>
        )}
        {!closed && (
          <button className="bl-btn danger" onClick={stop} title="Close this browser">
            Stop
          </button>
        )}
      </div>

      {error && <div className="bl-err">{error}</div>}
      {!!log.length && (
        <ul className="bl-log">
          {log.slice(-6).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {!!status?.downloads?.length && (
        <div className="bl-dl">
          {status.downloads.slice(-3).map((d, i) => (
            <span key={i} className="bl-dl-item" title={d.path}>
              ⬇ {d.name} · {fmtBytes(d.bytes)}
            </span>
          ))}
        </div>
      )}
    </aside>
  );
}