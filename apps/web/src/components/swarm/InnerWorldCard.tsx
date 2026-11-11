"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Brain, Wrench, Database, Gauge, CircleAlert, Sparkles } from "lucide-react";
import type { AgentStreamState, AgentEventType } from "@/lib/agentStreamStore";
import styles from "./innerWorld.module.css";

const TYPE_META: Record<AgentEventType, { color: string; Icon: any; label: string }> = {
  thought: { color: "bg-violet-400", Icon: Brain, label: "thought" },
  tool_call: { color: "bg-cyan-400", Icon: Wrench, label: "tool→" },
  tool_result: { color: "bg-emerald-400", Icon: Wrench, label: "→tool" },
  memory: { color: "bg-amber-400", Icon: Database, label: "memory" },
  state: { color: "bg-pink-400", Icon: Gauge, label: "state" },
  error: { color: "bg-red-500", Icon: CircleAlert, label: "error" },
};

const FLASH_CLASS: Record<AgentEventType, string> = {
  thought: styles.feedItemThought,
  tool_call: styles.feedItemTool,
  tool_result: styles.feedItemResult,
  memory: styles.feedItemMemory,
  state: styles.feedItemState,
  error: styles.feedItemErr,
};

const TERMINAL_PHASES = new Set(["done", "complete", "completed", "finish", "finished", "archived"]);

type Lifecycle = "spawning" | "active" | "idle" | "settled" | "error";

export function deriveLifecycle(agent: AgentStreamState, now: number): Lifecycle {
  const last = agent.lastEvent;
  if (last?.type === "error") return "error";
  if (last?.type === "state") {
    const phase = String(last.payload.phase ?? "").toLowerCase();
    if (TERMINAL_PHASES.has(phase)) return "settled";
  }
  if (now - agent.lastSeen > 8000) return "settled";
  if (now - agent.lastSeen > 5000) return "idle";
  if (agent.eventCount <= 2) return "spawning";
  return "active";
}

export function ttcTier(agent: AgentStreamState): 0 | 1 | 2 | 3 {
  // events-per-recent-window proxy for "time to completion" pace
  const pace = agent.sparkline.reduce((a, b) => a + b, 0);
  if (pace > 40) return 3;
  if (pace > 18) return 2;
  if (pace > 6) return 1;
  return 0;
}

interface Props {
  agent: AgentStreamState;
  dense: boolean;
  onFocus?: (agent: AgentStreamState, rect: DOMRect) => void;
}

/* Stable per-agent stagger: deterministic hash so remounts don't reshuffle. */
function staggerFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 420;
}

function Sparkline({ values, active }: { values: number[]; active: boolean }) {
  const max = Math.max(1, ...values);
  const { points, head } = useMemo(() => {
    const w = 100;
    const h = 16;
    const step = w / Math.max(1, values.length - 1);
    let hi = 0;
    let hv = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] > 0) {
        hi = i;
        hv = values[i];
      }
    }
    return {
      points: values.map((v, i) => `${i * step},${h - (v / max) * h}`).join(" "),
      head: { x: hi * step, y: h - (hv / max) * h, show: hv > 0 },
    };
  }, [values, max]);
  return (
    <svg viewBox="0 0 100 16" className="w-full h-4" preserveAspectRatio="none">
      <polyline fill="none" stroke="rgba(167,139,250,0.65)" strokeWidth="1" points={points} />
      {active && head.show && (
        <circle className={styles.headDot} cx={head.x} cy={head.y} r="1.8" />
      )}
    </svg>
  );
}

/* Thought typewriter throttled to the store's 250ms tick:
   reveals one step per tick via CSS-independent interval matching the tick. */
function TypedText({ text, active }: { text: string; active: boolean }) {
  const [shown, setShown] = useState(text);
  const prev = useRef(text);
  useEffect(() => {
    if (text === prev.current) return;
    const from = prev.current;
    prev.current = text;
    if (!active || text.length <= from.length || !text.startsWith(from.slice(0, 8))) {
      setShown(text);
      return;
    }
    let i = Math.min(from.length, text.length - 1);
    const t = setInterval(() => {
      i += 2;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(t);
    }, 40);
    return () => clearInterval(t);
  }, [text, active]);
  return (
    <span className={active && shown !== text ? styles.typeCaret : undefined}>{shown}</span>
  );
}

function InnerWorldCardBase({ agent, dense, onFocus }: Props) {
  const meta = agent.lastEvent ? TYPE_META[agent.lastEvent.type] : TYPE_META.state;
  const Icon = meta.Icon;
  const now = Date.now();
  const lifecycle = deriveLifecycle(agent, now);
  const tier = ttcTier(agent);
  const rootRef = useRef<HTMLDivElement>(null);
  const stagger = useMemo(() => staggerFor(agent.agentId), [agent.agentId]);

  const handleClick = () => {
    if (!onFocus || !rootRef.current) return;
    onFocus(agent, rootRef.current.getBoundingClientRect());
  };

  if (dense) {
    return (
      <div
        ref={rootRef}
        className={`${styles.denseCard} ${styles.denseCardSpawning} rounded border p-1.5 flex items-center gap-1.5 overflow-hidden ${
          lifecycle === "error"
            ? `${styles.cardError} border-red-500/40 bg-red-500/[0.06]`
            : "border-white/5 bg-white/[0.02]"
        }`}
        style={{ ["--iw-stagger" as any]: `${stagger}ms` }}
        title={`${agent.agentId} · ${agent.eventCount} events`}
        onClick={handleClick}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            lifecycle === "active" || lifecycle === "spawning"
              ? `${meta.color} ${styles.statusDot}`
              : "bg-white/20"
          }`}
        />
        <span className="text-[9px] font-mono text-white/50 truncate">{agent.agentId}</span>
      </div>
    );
  }

  const lifecycleCls =
    lifecycle === "error"
      ? styles.cardError
      : lifecycle === "settled"
        ? styles.cardSettled
        : lifecycle === "spawning"
          ? styles.cardSpawning
          : "";

  const badgeCls =
    tier === 3 ? styles.badgeGlowT3 : tier === 2 ? styles.badgeGlowT2 : tier === 1 ? styles.badgeGlowT1 : "";

  return (
    <div
      ref={rootRef}
      onClick={handleClick}
      role={onFocus ? "button" : undefined}
      tabIndex={onFocus ? 0 : undefined}
      className={`${styles.card} ${lifecycleCls} rounded-lg border border-white/8 bg-white/[0.025] hover:bg-white/[0.05] transition-colors p-3 space-y-2 cursor-pointer`}
      style={{ ["--iw-stagger" as any]: `${stagger}ms` }}
    >
      {(lifecycle === "active" || lifecycle === "spawning") && (
        <div className={styles.scanline} style={{ ["--iw-stagger" as any]: `${stagger}ms` }} />
      )}
      <div className="relative z-[2] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`h-2 w-2 rounded-full shrink-0 ${
              lifecycle === "active" || lifecycle === "spawning"
                ? `${meta.color} ${styles.statusDot}`
                : lifecycle === "error"
                  ? `bg-red-500 ${styles.statusDot}`
                  : "bg-white/20"
            }`}
          />
          <span className="text-[11px] font-mono text-white/80 truncate">{agent.agentId}</span>
        </div>
        <span className={`text-[9px] font-mono text-white/30 px-1 rounded ${badgeCls}`}>
          {agent.eventCount}
        </span>
      </div>
      <div className="relative z-[2]">
        <Sparkline values={agent.sparkline} active={lifecycle === "active" || lifecycle === "spawning"} />
      </div>
      {agent.lastEvent && (
        <div
          key={agent.lastEvent.id}
          className={`${styles.feedItem} ${FLASH_CLASS[agent.lastEvent.type]} relative z-[2] flex items-center gap-1 text-white/35 rounded-sm pl-1`}
        >
          <Icon size={11} className="shrink-0" />
          <span className="text-[10px] truncate">
            {agent.lastEvent.type === "thought" ? (
              <TypedText
                text={String(agent.lastEvent.payload.text ?? "…").slice(0, 60)}
                active={lifecycle === "active" || lifecycle === "spawning"}
              />
            ) : (
              summarize(agent.lastEvent.type, agent.lastEvent.payload)
            )}
          </span>
        </div>
      )}
      <div className="relative z-[2] flex gap-1 flex-wrap">
        {agent.recentTypes.slice(-5).map((t, i) => (
          <span
            key={i}
            className={`h-1 w-3 rounded-full ${TYPE_META[t].color} ${
              i === agent.recentTypes.length - 1 ? "opacity-100" : "opacity-40"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function summarize(type: AgentEventType, payload: Record<string, unknown>): string {
  if (type === "thought") return String(payload.text ?? "…").slice(0, 40);
  if (type === "tool_call") return `→ ${String(payload.tool ?? "tool")}`;
  if (type === "tool_result") return payload.ok === false ? "✗ tool failed" : "✓ result";
  if (type === "memory") return `mem ${String(payload.op ?? "")}`;
  if (type === "state") return `state ${String(payload.phase ?? "")}`;
  if (type === "error") return `err ${String(payload.message ?? "").slice(0, 30)}`;
  return type;
}

const InnerWorldCard = memo(InnerWorldCardBase, (a, b) => {
  return (
    a.dense === b.dense &&
    a.agent.agentId === b.agent.agentId &&
    a.agent.eventCount === b.agent.eventCount &&
    a.agent.lastSeen === b.agent.lastSeen &&
    a.onFocus === b.onFocus
  );
});
export default InnerWorldCard;

export { Sparkles as _InnerWorldIcon };
