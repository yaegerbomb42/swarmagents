"use client";

import { useEffect, useState } from "react";
import type { AgentEvent, PlanItem, ContextInfo } from "@/lib/types";

interface ProgressBarProps {
  events: AgentEvent[];
  running: boolean;
  context: ContextInfo | null;
  startTs: number; // timestamp of first user message
}

function fmtK(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  }
  return String(n);
}

function getGoal(events: AgentEvent[]): string {
  const msg = events.find(
    (e: any) => e.type === "user_message" || (e.type === "message" && e.role === "user")
  ) as any;
  const text = msg?.content || "";
  if (text.length > 60) return text.substring(0, 60) + "...";
  return text || "Processing...";
}

function getCurrentStep(events: AgentEvent[], running: boolean): string {
  if (!running && events.length > 0) return "Done";
  if (events.length === 0) return "Starting...";
  const last = events[events.length - 1] as any;
  switch (last.type) {
    case "tool_call":
      return `Running ${last.toolName}...`;
    case "thought":
      return "Thinking...";
    case "message_chunk":
    case "message":
      if (last.role === "assistant") return "Writing...";
      return "Processing...";
    default:
      return "Processing...";
  }
}

function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m % 60}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function ProgressBar({ events, running, context, startTs }: ProgressBarProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running]);

  if (!running && events.length === 0) return null;

  const goal = getGoal(events);
  const currentStep = getCurrentStep(events, running);

  let inputTokens = 0;
  let outputTokens = 0;
  for (const e of events) {
    const anyE = e as any;
    if (anyE.type === "turn" && anyE.metrics) {
      inputTokens += anyE.metrics.inputTokens || 0;
      outputTokens += anyE.metrics.outputTokens || 0;
    }
  }

  const cost = ((inputTokens / 1000000) * 3 + (outputTokens / 1000000) * 15).toFixed(4);

  // Parse plan from context if available
  const planSteps: PlanItem[] = (context as any)?.plan || [];
  const totalSteps = planSteps.length;
  const completedSteps = planSteps.filter((s: any) => s.status === "completed" || s.status === "done").length;

  const lastEventTs = events.length > 0 ? (events[events.length - 1] as any).ts : 0;
  const elapsedMs = running ? now - startTs : (lastEventTs || now) - startTs;

  return (
    <div className="progress-hero">
      <div className="progress-hero-inner">
        <div className="progress-goal">
          <span className="label">Goal:</span> {goal}
        </div>
        <div className="progress-step">
          {running && <span className="pulse-dot" />}
          <span className="label">Current:</span> {currentStep}
        </div>
        {totalSteps > 0 && (
          <div className="progress-plan">
            <span className="label">Plan:</span> {completedSteps}/{totalSteps} steps
          </div>
        )}
        <div className="progress-elapsed">
          <span className="label">Elapsed:</span> {formatElapsed(elapsedMs)}
        </div>
        <div className="progress-tokens">
          <span className="label">Tokens:</span> {fmtK(inputTokens)} in &middot; {fmtK(outputTokens)} out
        </div>
        <div className="progress-cost">
          <span className="label">Cost:</span> ~${cost}
        </div>
      </div>
    </div>
  );
}
