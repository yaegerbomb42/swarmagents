"use client";

import { useState, useMemo, useEffect } from "react";
import type { AgentEvent } from "@/lib/types";
import { ICheck, IX } from "./icons";

interface AwayRecapProps {
  events: AgentEvent[];
  running: boolean;
  sessionId?: string;
}

export function AwayRecap({ events, running }: AwayRecapProps) {
  const [dismissed, setDismissed] = useState(false);
  const [lastSeenCount, setLastSeenCount] = useState<number | null>(null);

  // Track visibility state of document to detect when user was away
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        setLastSeenCount(events.length);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [events.length]);

  const recap = useMemo(() => {
    if (lastSeenCount === null || events.length <= lastSeenCount + 1) return null;
    const newEvents = events.slice(lastSeenCount);
    if (newEvents.length === 0) return null;

    const toolCalls = newEvents.filter((e) => e.type === "tool");
    const fileEdits = toolCalls.filter((e) => e.type === "tool" && (e.name === "write_file" || e.name === "edit_file"));
    const commands = toolCalls.filter((e) => e.type === "tool" && e.name === "bash");
    const errors = toolCalls.filter((e) => e.type === "tool" && e.status === "error");

    let tokens = 0;
    for (const e of newEvents) {
      if (e.type === "turn") {
        tokens += e.inputTokens + e.outputTokens;
      }
    }

    return {
      count: newEvents.length,
      toolCount: toolCalls.length,
      fileCount: fileEdits.length,
      cmdCount: commands.length,
      errorCount: errors.length,
      tokens,
    };
  }, [events, lastSeenCount]);

  if (!recap || dismissed) return null;

  return (
    <div className="away-recap-banner" role="status" aria-label="While you were away summary">
      <div className="away-recap-content">
        <span className="away-recap-badge">While you were away</span>
        <span className="away-recap-text">
          Completed {recap.toolCount} actions
          {recap.fileCount > 0 ? ` · ${recap.fileCount} file${recap.fileCount > 1 ? "s" : ""} modified` : ""}
          {recap.cmdCount > 0 ? ` · ${recap.cmdCount} command${recap.cmdCount > 1 ? "s" : ""}` : ""}
          {recap.errorCount > 0 ? ` · ${recap.errorCount} warning${recap.errorCount > 1 ? "s" : ""}` : ""}
          {recap.tokens > 0 ? ` · ${(recap.tokens / 1000).toFixed(1)}k tokens` : ""}
        </span>
      </div>
      <button className="away-recap-close" onClick={() => setDismissed(true)} title="Dismiss">
        <IX />
      </button>
    </div>
  );
}
