"use client";

import { useEffect, useState, useMemo } from "react";
import type { AgentEvent, PlanItem, ContextInfo } from "@/lib/types";

interface ProgressBarProps {
  events: AgentEvent[];
  running: boolean;
  context: ContextInfo | null;
  startTs: number;
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function ProgressBar({ events, running, context, startTs }: ProgressBarProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Goal: first user message, truncated
  const goal = useMemo(() => {
    const user = events.find((e) => e.type === "user");
    if (!user || user.type !== "user") return "";
    const t = user.text || "";
    return t.length > 80 ? t.slice(0, 77) + "…" : t;
  }, [events]);

  // Current step: last active event
  const currentStep = useMemo(() => {
    if (!running) return "Done";
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "thinking" && !e.done) return "Thinking…";
      if (e.type === "text" && !e.done) return "Writing…";
      if (e.type === "tool" && (e.status === "running" || e.status === "streaming")) {
        const label = e.name.startsWith("mcp__")
          ? e.name.split("__").slice(1).join(" · ")
          : ({ bash: "Shell", read_file: "Reading", write_file: "Writing", edit_file: "Editing", search: "Searching", web_search: "Web search", web_fetch: "Fetching", browser: "Browser" } as Record<string, string>)[e.name] ?? e.name;
        const arg = Object.values((e.input ?? {}) as Record<string, unknown>).find((v) => typeof v === "string");
        return arg ? `${label} · ${String(arg).slice(0, 60)}` : label;
      }
    }
    return "Working…";
  }, [events, running]);

  // Token totals from turn events
  const { inputTokens, outputTokens, cachedTokens } = useMemo(() => {
    let inp = 0, out = 0, cached = 0;
    for (const e of events) {
      if (e.type === "turn") {
        inp += e.inputTokens;
        out += e.outputTokens;
        cached += e.cachedTokens;
      }
    }
    return { inputTokens: inp, outputTokens: out, cachedTokens: cached };
  }, [events]);

  // Plan progress from plan events
  const planInfo = useMemo(() => {
    const plans = events.filter((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>[];
    const latest = plans.at(-1);
    if (!latest) return null;
    const done = latest.items.filter((i) => i.status === "done").length;
    return { done, total: latest.items.length };
  }, [events]);

  const cost = ((inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15);
  const elapsed = startTs > 0 ? (running ? now : (events.at(-1)?.ts ?? now)) - startTs : 0;

  if (!events.length) return null;

  return (
    <div className="progress-hero" role="status" aria-label="Task progress">
      <div className="progress-hero-inner">
        {goal && (
          <div className="progress-cell progress-goal" title={goal}>
            <span className="progress-label">Goal</span>
            <span className="progress-value">{goal}</span>
          </div>
        )}
        <div className="progress-cell progress-step">
          {running && <span className="pulse-dot" />}
          <span className="progress-label">Step</span>
          <span className="progress-value">{currentStep}</span>
        </div>
        {planInfo && (
          <div className="progress-cell progress-plan">
            <span className="progress-label">Plan</span>
            <span className="progress-value">
              {planInfo.done}/{planInfo.total}
              <span className="progress-bar-mini">
                <span className="progress-bar-fill" style={{ width: `${(planInfo.done / planInfo.total) * 100}%` }} />
              </span>
            </span>
          </div>
        )}
        <div className="progress-cell progress-elapsed">
          <span className="progress-label">Elapsed</span>
          <span className="progress-value tabnum">{formatElapsed(elapsed)}</span>
        </div>
        <div className="progress-cell progress-tokens">
          <span className="progress-label">Tokens</span>
          <span className="progress-value tabnum">
            {fmtK(inputTokens)} in{cachedTokens > 0 ? ` (${fmtK(cachedTokens)} cached)` : ""} · {fmtK(outputTokens)} out
          </span>
        </div>
        {cost >= 0.001 && (
          <div className="progress-cell progress-cost">
            <span className="progress-label">Cost</span>
            <span className="progress-value tabnum">~${cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
