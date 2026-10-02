"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, Attachment, ContextInfo, SessionMeta, StreamOp } from "@/lib/types";
import { Timeline, LoadEarlier } from "@/components/Timeline";
import { ProgressBar } from "@/components/ProgressBar";
import { AwayRecap } from "@/components/AwayRecap";
import { ChangedFilesTree } from "@/components/ChangedFilesTree";
import { Composer } from "@/components/Composer";
import { Settings } from "@/components/Settings";
import { BrowserLive, useBrowserLive } from "@/components/BrowserLive"; // deploy lane 23:20: browser lane snippet (watch-live dock)
import { StorageBanner } from "@/components/StorageSettings"; // deploy lane 22:29: storage warning banner (Settings lane leftover)
import { Activity } from "@/components/Activity";
import { IActivity, IPlus, ISettings, ISidebar, IX } from "@/components/icons";
import { HexagonMark, Wordmark, MiniHexagon, WrenchMark } from "@/components/Brand";
import { LivingHexagon, EmptyStateHexagon, useHexagonState } from "@/components/HexagonMark";
import { canonicalHostSwap } from "@/lib/canonical";
import { Welcome, FIRST_TASKS } from "@/components/Welcome"; // Grok Bot: first-run welcome (Jimmy 23:12)

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
  const browser = useBrowserLive(active ?? undefined);
  const [livePanel, setLivePanel] = useState(true);
  const [archivedEvents, setArchivedEvents] = useState(0);
  // First run: null until /api/providers answers; `welcome` stays on from "no model yet" until the first task starts.
  const [hasModel, setHasModel] = useState<boolean | null>(null);
  const [welcome, setWelcome] = useState(false);
  const [primaryModel, setPrimaryModel] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [mainAmbient, setMainAmbient] = useState<"idle" | "thinking" | "working" | "error">("idle");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;

  // Derive hexagon state from agent events
  const hexagonState = useHexagonState(events, running);

  // Update ambient glow on main canvas based on agent state
  useEffect(() => {
    setMainAmbient(hexagonState);
  }, [hexagonState]);

  const refresh = useCallback(() => fetch("/api/sessions").then((r) => r.json()).then((d) => setSessions(d.sessions)), []);
  const checkModel = useCallback(
    () =>
      fetch("/api/providers")
        .then((r) => r.json())
        .then((d: { providers?: { label?: string; model?: string; enabled?: boolean }[] }) => {
          const has = !!d.providers?.length;
          const first = d.providers?.find((p) => p.enabled !== false);
          setPrimaryModel(first ? [first.label, first.model].filter(Boolean).join(" · ") : "");
          setHasModel(has);
          return has;
        })
        .catch(() => null),
    [],
  );

  useEffect(() => {
    // One local origin: localhost and 127.0.0.1 have separate localStorage.
    const swap = canonicalHostSwap(location.href);
    if (swap) {
      location.replace(swap);
      return;
    }
    refresh();
    checkModel().then((has) => has === false && setWelcome(true));
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
  }, [refresh, checkModel]);

  // Live stream for the open session.
  useEffect(() => {
    try {
      active ? localStorage.setItem("swarm.active", active) : localStorage.removeItem("swarm.active");
    } catch {}
    setEvents([]);
    setEarlier([]);
    setArchivedEvents(0);
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
        if (!op.running) {
          // When agent stops, update runningIds
          setRunningIds((prev) => {
            const next = new Set(prev);
            next.delete(active!);
            return next;
          });
        }
      }
    };
    return () => es.close();
  }, [active]);

  // Auto-scroll logic
  useLayoutEffect(() => {
    if (stick.current && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [events, running]);

  // Keep a live clock for elapsed time
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const ensureSession = useCallback(async () => {
    if (active) return active;
    const r = await fetch("/api/sessions", { method: "POST" });
    const { session } = await r.json();
    setActive(session.id);
    refresh();
    return session.id;
  }, [active, refresh]);

  const send = useCallback(
    async (text: string, atts: Attachment[]) => {
      const id = await ensureSession();
      const res = await fetch(`/api/sessions/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, attachments: atts }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Send failed" }));
        throw new Error(err.error);
      }
    },
    [ensureSession],
  );

  const stop = useCallback(async () => {
    if (!active) return;
    await fetch(`/api/sessions/${active}/stop`, { method: "POST" });
  }, [active]);

  const remove = useCallback(async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (active === id) setActive(null);
    refresh();
  }, [active, refresh]);

  // Earlier events paged in by "Show earlier" (GET /api/sessions/:id/events?before=). They live apart from the
  // streamed `events`, so a snapshot or a new token never drops them; the SSE effect resets them on session switch.
  // archivedEvents comes from the snapshot, then counts down as pages load. Merged by id, so nothing shows twice.
  const [earlier, setEarlier] = useState<AgentEvent[]>([]);
  const visible = useMemo(() => {
    if (!earlier.length) return events;
    const live = new Set(events.map((e) => e.id));
    return [...earlier.filter((e) => !live.has(e.id)), ...events];
  }, [earlier, events]);

  const handleLoadEarlier = useCallback((older: AgentEvent[], remaining: number) => {
    setEarlier((prev) => {
      const have = new Set(prev.map((e) => e.id));
      return [...older.filter((e) => !have.has(e.id)), ...prev];
    });
    setArchivedEvents(Math.max(0, remaining));
  }, []);

  // A suggested task: one click creates the task and starts it.
  const runTask = useCallback(
    async (text: string) => {
      await send(text, []);
      setWelcome(false);
      refresh();
    },
    [send, refresh],
  );

  // Session title for topbar
  const title = sessions.find((s) => s.id === active)?.title ?? null;

  // Activity text for running state
  const activityText = events.find((e) => e.type === "thinking" && !e.done)
    ? "Thinking…"
    : events.find((e) => e.type === "tool")
    ? "Working…"
    : "Running…";

  // Plan progress
  const planEvent = events.find((e) => e.type === "plan");
  const planProgress = planEvent
    ? `${planEvent.items.filter((i) => i.status === "done").length}/${planEvent.items.length}`
    : null;

  // Elapsed time
  const firstUser = events.find((e) => e.type === "user");
  const elapsedMs = firstUser ? now - firstUser.ts : 0;
  const elapsedLabel = elapsedMs < 60000 ? `${Math.round(elapsedMs / 1000)}s` : `${Math.floor(elapsedMs / 60000)}m`;

  const livePlanOpen = events.some((e) => e.type === "plan" && !(e as any).done);

  return (
    <div className="app">
      <aside className={`sidebar${!sidebar ? " closed" : ""}`}>
        <div className="side-head">
          <div className="brand-row" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <MiniHexagon size={20} state={hexagonState} />
            <span className="brand">SwarmAgents</span>
          </div>
          <button className="icon-btn" onClick={refresh} title="Refresh sessions" aria-label="Refresh">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
        <div className="side-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`side-item${active === s.id ? " active" : ""}${runningIds.has(s.id) ? " running" : ""}`}
              onClick={() => setActive(s.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && setActive(s.id)}
            >
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
            <WrenchMark size={16} />
            <span className="t">Settings</span>
          </button>
        </div>
      </aside>

      <main className={`main ${mainAmbient !== "idle" ? `ambient-${mainAmbient}` : ""}`}>
        <div className="topbar">
          <button className="icon-btn" onClick={() => setSidebar(!sidebar)} title="Toggle sidebar" aria-label="Toggle sidebar">
            <ISidebar />
          </button>
          <LivingHexagon size={18} state={hexagonState} className="topbar-hexagon" />
          {title && <span className="title" title={title}>{title}</span>}
          {active && (
            <div className={`task-status${running ? " is-running" : ""}`} aria-live="polite">
              <span className="task-status-dot" />
              <span className="task-status-label">{running ? activityText : "Ready"}</span>
              {running && <span className="task-status-meta">{planProgress && <span>{planProgress}</span>}<span>{elapsedLabel}</span></span>}
            </div>
          )}
        </div>
        <StorageBanner onOpen={() => setSettings(true)} />

        <div
          className="scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {!visible.length ? (
            welcome || hasModel === false ? (
              <div className="empty">
                <Welcome connected={!!hasModel} onConnected={checkModel} onOpenSettings={() => setSettings(true)} onRunTask={runTask} />
              </div>
            ) : (
              <div className="empty">
                <div className="empty-content">
                  <EmptyStateHexagon state={hexagonState} className="empty-hexagon" />
                  <h1>What should we get done?</h1>
                  <p>Shell, files, browser, web and your connectors. Every step shows here as it happens.</p>
                  <div className="empty-examples" style={{ marginTop: "var(--space-6)", display: "flex", flexWrap: "wrap", gap: "var(--space-2)", justifyContent: "center" }}>
                    {FIRST_TASKS.map((t) => (
                      <button key={t.title} type="button" className="example-chip" title={t.text} onClick={() => runTask(t.text).catch(() => {})}>
                        {t.title}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="col">
              <ProgressBar events={visible} running={running} context={context} startTs={visible.find((e) => e.type === "user")?.ts ?? 0} />
              <AwayRecap events={visible} running={running} sessionId={active ?? undefined} />
              <ChangedFilesTree events={visible} session={active ?? undefined} />
              {active && archivedEvents > 0 && <LoadEarlier key={active} archivedCount={archivedEvents} sessionId={active} onLoad={(older, start) => activeRef.current === active && handleLoadEarlier(older, start)} />}
              <Timeline events={visible} onImage={setLightbox} session={active ?? undefined} />
              {running && !livePlanOpen && visible.at(-1)?.type !== "thinking" && visible.at(-1)?.type !== "text" && (
                <div className="ev thinking">
                  <span className="shimmer">Working…</span>
                </div>
              )}
            </div>
          )}
        </div>

        <Composer running={running} context={context} ensureSession={ensureSession} onSend={send} onStop={stop} primary={primaryModel} />
      </main>

      {settings && (
        <Settings
          notice={notice}
          onClose={() => {
            setSettings(false);
            setNotice(undefined);
            checkModel(); // a model added in Settings moves the welcome card to step 2
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
      {browser.live && livePanel && active && <BrowserLive sessionId={active} onClose={() => setLivePanel(false)} />}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}
