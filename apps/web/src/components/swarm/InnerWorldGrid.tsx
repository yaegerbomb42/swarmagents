"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import InnerWorldCard from "./InnerWorldCard";
import AgentChat from "@/components/AgentChat";
import {
  agentStreamStore,
  type AgentEvent,
  type AgentStreamState,
} from "@/lib/agentStreamStore";
import styles from "./innerWorld.module.css";

export type DensityMode = "cozy" | "compact" | "dense";

interface Props {
  density?: DensityMode;
  filter?: string;
  focusEnabled?: boolean;
}

const GRID_CONFIG: Record<DensityMode, { cardW: number; cardH: number; gap: number }> = {
  cozy: { cardW: 220, cardH: 130, gap: 12 },
  compact: { cardW: 180, cardH: 110, gap: 8 },
  dense: { cardW: 140, cardH: 32, gap: 4 },
};

const FLASH_CLASS: Record<string, string> = {
  thought: styles.feedItemThought,
  tool_call: styles.feedItemTool,
  tool_result: styles.feedItemResult,
  memory: styles.feedItemMemory,
  state: styles.feedItemState,
  error: styles.feedItemErr,
};

/* ---------- plain counter (no bump animation: numbers change, chrome doesn't) ---------- */

function Counter({ value, suffix, title }: { value: number; suffix: string; title: string }) {
  return (
    <span className="text-[11px] font-mono tabular-nums text-zinc-300" title={title}>
      {value.toLocaleString()}
      <span className="text-zinc-400"> {suffix}</span>
    </span>
  );
}

/* ---------- mission strip ---------- */

function MissionStrip({ agents, milestoneTick }: { agents: AgentStreamState[]; milestoneTick: number }) {
  const stats = useMemo(() => {
    // Honest numbers only: the stream carries events, not tokens or credits.
    let recentEvents = 0;
    let active = 0;
    let errorCount = 0;
    const now = Date.now();
    for (const a of agents) {
      recentEvents += a.sparkline.reduce((x, y) => x + y, 0);
      if (now - a.lastSeen < 5000) active++;
      if (a.lastEvent?.type === "error") errorCount++;
    }
    return { recentEvents, active, errorCount };
  }, [agents]);

  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (milestoneTick === 0) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 750);
    return () => clearTimeout(t);
  }, [milestoneTick]);

  return (
    <div
      className={`${flash ? styles.milestoneFlash : ""} flex items-center gap-4 rounded-lg border border-white/8 bg-white/[0.025] px-3 py-1.5 mb-2`}
    >
      <Counter value={stats.recentEvents} suffix="events / 20s" title="events received across the swarm in the last 20 seconds" />
      <Counter value={stats.active} suffix="active" title="agents that emitted an event in the last 5s" />
      {stats.errorCount > 0 && (
        <span className="text-[10px] font-mono text-red-400/80">{stats.errorCount} err</span>
      )}
    </div>
  );
}

/* ---------- focus reading view ---------- */

interface FocusState {
  agent: AgentStreamState;
  fromRect: DOMRect;
}

function str(v: unknown, max = 96): string {
  if (v === undefined || v === null) return "";
  const t = typeof v === "string" ? v : JSON.stringify(v);
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** One-line human summary of an agent event, keyed by kind. */
export function summarizeAgentEvent(type: AgentEvent["type"], p: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (p[k] !== undefined && p[k] !== null && p[k] !== "") return p[k];
    return undefined;
  };
  switch (type) {
    case "thought":
      return str(pick("text", "thought", "content", "message")) || "thought";
    case "tool_call": {
      const tool = str(pick("tool", "name", "fn", "action"), 40) || "tool";
      const args = str(pick("args", "params", "input", "command", "path", "url"), 72);
      return args ? `${tool}(${args})` : `${tool}()`;
    }
    case "tool_result": {
      const tool = str(pick("tool", "name"), 40);
      const ok = p.ok === false || p.error ? "failed" : "ok";
      const out = str(pick("summary", "output", "result", "error"), 72);
      return [tool, ok, out].filter(Boolean).join(" · ");
    }
    case "memory": {
      const key = str(pick("key", "path"), 40);
      const val = str(pick("value", "text", "summary"), 64);
      return key ? `${key} = ${val || "…"}` : val || "memory write";
    }
    case "state": {
      const from = str(pick("from", "prev"), 24);
      const to = str(pick("to", "status", "state"), 24);
      return from && to ? `${from} → ${to}` : to || "state change";
    }
    case "error":
      return str(pick("message", "error", "text")) || "error";
    default:
      return str(p);
  }
}

function EventSummary({ type, payload }: { type: AgentEvent["type"]; payload: Record<string, unknown> }) {
  const [raw, setRaw] = useState(false);
  const summary = useMemo(() => summarizeAgentEvent(type, payload), [type, payload]);
  return (
    <div className="min-w-0">
      <div className="flex items-start gap-2">
        <span className="flex-1 min-w-0 truncate text-zinc-300" title={summary}>{summary}</span>
        <button
          type="button"
          onClick={() => setRaw((r) => !r)}
          className="shrink-0 rounded border border-white/10 px-1 text-[10px] text-zinc-400 hover:text-zinc-200"
          aria-pressed={raw}
        >
          raw
        </button>
      </div>
      {raw && (
        <pre className="mt-1 text-zinc-400 whitespace-pre-wrap break-all">{JSON.stringify(payload, null, 2)}</pre>
      )}
    </div>
  );
}

const FocusPanel = memo(function FocusPanel({
  focus,
  onClose,
}: {
  focus: FocusState;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"events" | "chat">("events");

  const events = useSyncExternalStore(
    (cb) => agentStreamStore.subscribe(cb),
    () => agentStreamStore.bufferSnapshot(),
    () => [] as AgentEvent[]
  );

  const agentEvents = useMemo(() => {
    return events.filter((e) => e.agentId === focus.agent.agentId).slice(-200).reverse();
  }, [events, focus.agent.agentId]);

  useEffect(() => {
    const t = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const target = useMemo(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(640, vw - 32);
    const h = Math.min(560, vh - 32);
    return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h };
  }, []);

  const rect = open
    ? target
    : { left: focus.fromRect.left, top: focus.fromRect.top, width: focus.fromRect.width, height: focus.fromRect.height };

  return (
    <>
      <div
        className={`${styles.focusOverlay} ${open ? styles.focusOverlayOpen : ""}`}
        onClick={onClose}
      />
      <div className={styles.focusPanel} style={rect} role="dialog" aria-label={`${focus.agent.agentId} event reader`}>
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <span className="text-[11px] font-mono text-white/80">{focus.agent.agentId}</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 text-[10px] font-mono bg-white/5 rounded p-0.5 border border-white/10">
              <button
                type="button"
                onClick={() => setTab("events")}
                className={`px-2 py-0.5 rounded transition ${
                  tab === "events" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
                }`}
              >
                events
              </button>
              <button
                type="button"
                onClick={() => setTab("chat")}
                className={`px-2 py-0.5 rounded transition ${
                  tab === "chat" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
                }`}
              >
                chat
              </button>
            </div>
            <span className="text-[10px] font-mono text-white/35">
              {agentEvents.length} events · esc to close
            </span>
          </div>
        </div>
        {tab === "events" ? (
          <div className={`${styles.focusScroll} h-[calc(100%-37px)] overflow-y-auto p-2 space-y-1`}>
            {agentEvents.map((e) => (
              <div
                key={e.id}
                className={`${styles.feedItem} ${FLASH_CLASS[e.type]} rounded border border-white/5 bg-white/[0.02] px-2 py-1 text-[10px] font-mono text-white/60`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-white/75">{e.type}</span>
                  <span className="text-white/25">{new Date(e.timestamp).toLocaleTimeString()}</span>
                </div>
                <EventSummary type={e.type} payload={e.payload} />
              </div>
            ))}
            {agentEvents.length === 0 && (
              <div className="text-white/25 text-[11px] font-mono p-4 text-center">
                no buffered events for this agent
              </div>
            )}
          </div>
        ) : (
          <div className="h-[calc(100%-37px)] bg-white text-[#111] rounded-b-md overflow-hidden">
            <AgentChat projectId={null} active={false} className="h-full" />
          </div>
        )}
      </div>
    </>
  );
});

/* ---------- grid ---------- */

export default function InnerWorldGrid({ density = "compact", filter = "", focusEnabled = true }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [focus, setFocus] = useState<FocusState | null>(null);
  const [milestoneTick, setMilestoneTick] = useState(0);
  const lastMilestoneEvt = useRef<string | null>(null);

  const agents = useSyncExternalStore(
    (cb) => agentStreamStore.subscribe(cb),
    () => agentStreamStore.agentsSnapshot(),
    () => [] as AgentStreamState[]
  );

  // milestone detection: newest buffered [state] event bumps the strip flash
  useEffect(() => {
    const unsub = agentStreamStore.subscribe(() => {
      const buf = agentStreamStore.bufferSnapshot();
      for (let i = buf.length - 1; i >= 0 && i > buf.length - 40; i--) {
        const e = buf[i];
        if (e.type === "state" && e.id !== lastMilestoneEvt.current) {
          lastMilestoneEvt.current = e.id;
          setMilestoneTick((t) => t + 1);
          break;
        }
        if (e.id === lastMilestoneEvt.current) break;
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!parentRef.current) return;
    const el = parentRef.current;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setWidth(r.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // keyboard: f focuses hovered/last-active agent, Esc closes
  useEffect(() => {
    if (!focusEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(null);
      if (e.key === "f" && !focus) {
        const target = document.activeElement?.closest?.("[data-iw-card]") as HTMLElement | null;
        const list = agentStreamStore.agentsSnapshot();
        const mostRecent = [...list].sort((a, b) => b.lastSeen - a.lastSeen)[0];
        if (target) {
          const id = target.getAttribute("data-iw-card");
          const a = list.find((x) => x.agentId === id);
          if (a) setFocus({ agent: a, fromRect: target.getBoundingClientRect() });
        } else if (mostRecent) {
          const el = document.querySelector(`[data-iw-card="${mostRecent.agentId}"]`) as HTMLElement | null;
          const r = el?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 1, 1);
          setFocus({ agent: mostRecent, fromRect: r });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, focusEnabled]);

  const handleFocus = useCallback((agent: AgentStreamState, rect: DOMRect) => {
    setFocus({ agent, fromRect: rect });
  }, []);

  const cfg = GRID_CONFIG[density];
  const cols = Math.max(1, Math.floor((width + cfg.gap) / (cfg.cardW + cfg.gap)));

  const filtered = useMemo(() => {
    const list = agents;
    if (!filter) return list;
    const f = filter.toLowerCase();
    return list.filter((a) => a.agentId.toLowerCase().includes(f));
  }, [agents, filter]);

  const rows = Math.ceil(filtered.length / cols);

  const rowVirtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cfg.cardH + cfg.gap,
    overscan: 3,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <div className="h-full w-full flex flex-col">
      <MissionStrip agents={agents} milestoneTick={milestoneTick} />
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div style={{ height: totalSize, position: "relative" }}>
          {virtualRows.map((vr) => {
            const start = vr.index * cols;
            const rowAgents = filtered.slice(start, start + cols);
            return (
              <div
                key={vr.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vr.start}px)`,
                  display: "grid",
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  gap: cfg.gap,
                  height: cfg.cardH,
                }}
              >
                {rowAgents.map((a) => (
                  <div key={a.agentId} data-iw-card={a.agentId} style={{ height: "100%", minHeight: 0 }}>
                    <InnerWorldCard agent={a} dense={density === "dense"} onFocus={focusEnabled ? handleFocus : undefined} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {filtered.length === 0 && (
          <div className="flex h-full items-center justify-center text-white/25 text-sm">
            No agents match filter
          </div>
        )}
      </div>
      {focus && <FocusPanel focus={focus} onClose={() => setFocus(null)} />}
    </div>
  );
}
