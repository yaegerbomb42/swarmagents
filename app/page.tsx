"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentEvent, Attachment, ContextInfo, SessionMeta, StreamOp } from "@/lib/types";
import { Timeline, LoadEarlier } from "@/components/Timeline";
import { ProgressBar } from "@/components/ProgressBar";
import { Composer } from "@/components/Composer";
import { Settings } from "@/components/Settings";
import { Activity } from "@/components/Activity";
import { IActivity, IPlus, ISettings, ISidebar, IX } from "@/components/icons";
import { BrandMark, BrandWordmark } from "@/components/brand";
import { canonicalHostSwap } from "@/lib/canonical";

export default function Home() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState<{ connected?: string | null; error?: string | null }>();
  const [activityOpen, setActivityOpen] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [archivedEvents, setArchivedEvents] = useState(0);
  const [now, setNow] = useState(Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;

  const refresh = useCallback(() => fetch("/api/sessions").then((r) => r.json()).then((d) => setSessions(d.sessions)), []);

  useEffect(() => {
    // One local origin: localhost and 127.0.0.1 have separate localStorage.
    const swap = canonicalHostSwap(location.href);
    if (swap) {
      location.replace(swap);
      return;
    }
    refresh();
    fetch("/api/providers")
      .then((r) => r.json())
      .then((d) => !d.providers.length && setSettings(true));
    // Returning from a one-click provider connection.
    const qs = new URLSearchParams(location.search);
    if (qs.has("connected") || qs.has("connect_error")) {
      setNotice({ connected: qs.get("connected"), error: qs.get("connect_error") });
      setSettings(true);
      history.replaceState(null, "", "/");
    }
    const last = localStorage.getItem("swarm.active");
    if (last) setActive(last);
    if (window.innerWidth < 760) setSidebar(false);
  }, [refresh]);

  // Live stream for the open session.
  useEffect(() => {
    try {
      active ? localStorage.setItem("swarm.active", active) : localStorage.removeItem("swarm.active");
    } catch {}
    setEvents([]);
    setContext(null);
    setRunning(false);
    if (!active) return;
    stick.current = true;
    const es = new EventSource(`/api/sessions/${active}`);
    es.onmessage = (m) => {
      const op = JSON.parse(m.data) as StreamOp;
      if (op.op === "snapshot") {
        setEvents(op.events);
        setRunning(op.running);
        setContext(op.context);
        setArchivedEvents(op.meta?.archivedEvents ?? 0);
      } else if (op.op === "add") setEvents((x) => [...x, op.event]);
      else if (op.op === "patch")
        setEvents((x) =>
          x.map((e) => {
            if (e.id !== op.id) return e;
            const n = { ...e, ...op.patch } as Record<string, unknown>;
            if (op.append) n[op.append.field] = ((e as unknown as Record<string, string>)[op.append.field] ?? "") + op.append.value;
            return n as unknown as AgentEvent;
          }),
        );
      else if (op.op === "running") {
        setRunning(op.running);
        setRunningIds((s) => {
          const n = new Set(s);
          op.running ? n.add(active) : n.delete(active);
          return n;
        });
        if (!op.running) refresh();
      } else if (op.op === "context") setContext(op.context);
    };
    es.onerror = () => {
      // 404 means the session is gone (deleted elsewhere); otherwise EventSource reconnects itself.
      fetch(`/api/sessions`).then((r) => r.json()).then((d) => !d.sessions.some((s: SessionMeta) => s.id === active) && (es.close(), setActive(null)));
    };
    return () => es.close();
  }, [active, refresh]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const ensureSession = useCallback(async () => {
    if (activeRef.current) return activeRef.current;
    const d = await fetch("/api/sessions", { method: "POST" }).then((r) => r.json());
    activeRef.current = d.session.id;
    setActive(d.session.id);
    refresh();
    return d.session.id as string;
  }, [refresh]);

  const send = async (text: string, attachments: Attachment[]) => {
    const id = await ensureSession();
    stick.current = true;
    await fetch(`/api/sessions/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, attachments }) });
    setTimeout(refresh, 400);
  };

  const stop = useCallback(() => active && fetch(`/api/sessions/${active}/stop`, { method: "POST" }), [active]);

  const remove = async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (id === active) setActive(null);
    refresh();
  };

  const visible = events.filter((e) => !(e as { hidden?: boolean }).hidden);
  const plans = visible.filter((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>[];
  const livePlan = running ? plans.at(-1) : undefined;
  const livePlanOpen = livePlan && livePlan.items.some((i) => i.status !== "done");
  const title = sessions.find((s) => s.id === active)?.title;
  const currentTool = [...visible].reverse().find((e) => e.type === "tool" && (e.status === "running" || e.status === "streaming"));
  const latestUser = [...visible].reverse().find((e) => e.type === "user");
  const completedPlanItems = livePlan?.items.filter((item) => item.status === "done").length ?? 0;
  const planProgress = livePlan ? `${completedPlanItems}/${livePlan.items.length} steps` : "";
  const elapsed = latestUser ? Math.max(0, Math.floor((now - latestUser.ts) / 1000)) : 0;
  const elapsedLabel = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const toolLabel = currentTool?.type === "tool"
    ? currentTool.name.startsWith("mcp__")
      ? currentTool.name.split("__").slice(1).join(" · ")
      : ({ bash: "Shell", read_file: "Reading files", write_file: "Writing files", edit_file: "Editing files", search: "Searching files", web_search: "Searching the web", web_fetch: "Reading a web page", browser: "Using browser" } as Record<string, string>)[currentTool.name] ?? currentTool.name
    : "Working";
  const toolArg = currentTool?.type === "tool"
    ? Object.values((currentTool.input ?? {}) as Record<string, unknown>).find((value) => typeof value === "string")
    : undefined;
  const activityText = currentTool?.type === "tool" && toolArg
    ? `${toolLabel} · ${String(toolArg).replace(/\s+/g, " ").slice(0, 72)}`
    : toolLabel;

  return (
    <div className="app">
      <aside className={`sidebar${sidebar ? "" : " closed"}`}>
        <div className="side-head">
          <span className="brand brand-lockup"><BrandWordmark height={20} /></span>
          <button className="icon-btn" title="New task (⌘K)" onClick={() => setActive(null)}>
            <IPlus />
          </button>
        </div>
        <div className="side-list">
          {sessions.map((s) => (
            <div key={s.id} className={`side-item${s.id === active ? " active" : ""}`} onClick={() => setActive(s.id)} role="button">
              {runningIds.has(s.id) && <span className="live-dot" />}
              <span className="t">{s.title}</span>
              <button
                className="x"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm("Delete this task and its uploads?")) remove(s.id);
                }}
              >
                <IX />
              </button>
            </div>
          ))}
        </div>
        <div className="side-foot">
          <button className="side-item" onClick={() => setActivityOpen(true)}>
            <IActivity />
            <span className="t">Activity</span>
          </button>
          <button className="side-item" onClick={() => setSettings(true)}>
            <ISettings />
            <span className="t">Settings</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="icon-btn" onClick={() => setSidebar(!sidebar)} title="Toggle sidebar">
            <ISidebar />
          </button>
          <BrandMark size={18} className="topbar-mark" label="SwarmAgents" />
          {title && <span className="title" title={title}>{title}</span>}
          {active && (
            <div className={`task-status${running ? " is-running" : ""}`} aria-live="polite">
              <span className="task-status-dot" />
              <span className="task-status-label">{running ? activityText : "Ready"}</span>
              {running && <span className="task-status-meta">{planProgress && <span>{planProgress}</span>}<span>{elapsedLabel}</span></span>}
            </div>
          )}
        </div>

        <div
          className="scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {!visible.length ? (
            <div className="empty">
              <div>
                <BrandMark size={64} className="empty-mark brand-glow" />
                <h1>What should we get done?</h1>
                <p>Shell, files, browser, web and your connectors. Every step shows here as it happens.</p>
              </div>
            </div>
          ) : (
            <div className="col">
              <ProgressBar events={visible} running={running} context={context} startTs={visible.find((e) => e.type === "user")?.ts ?? 0} />
              {active && archivedEvents > 0 && <LoadEarlier archivedCount={archivedEvents} sessionId={active} />}
              <Timeline events={visible} onImage={setLightbox} session={active ?? undefined} />
              {running && !livePlanOpen && visible.at(-1)?.type !== "thinking" && visible.at(-1)?.type !== "text" && (
                <div className="ev thinking">
                  <span className="shimmer">Working…</span>
                </div>
              )}
            </div>
          )}
        </div>

        <Composer running={running} context={context} ensureSession={ensureSession} onSend={send} onStop={stop} />
      </main>

      {settings && (
        <Settings
          notice={notice}
          onClose={() => {
            setSettings(false);
            setNotice(undefined);
          }}
        />
      )}
      {activityOpen && (
        <Activity
          onClose={() => setActivityOpen(false)}
          onOpenSession={(id) => {
            setActive(id);
            setActivityOpen(false);
          }}
        />
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}
