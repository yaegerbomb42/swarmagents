"use client";

import { useEffect, useState } from "react";
import { HexagonMark, MiniHexagon } from "./Brand";

/**
 * Living hexagon that reacts to agent state via WebSocket events.
 * Receives state from the parent (page.tsx) which gets it from the SSE stream.
 */
export function LivingHexagon({
  size = 48,
  state = "idle", // "idle" | "thinking" | "working" | "error"
  className = "",
}: {
  size?: number;
  state?: "idle" | "thinking" | "working" | "error";
  className?: string;
}) {
  return <HexagonMark size={size} state={state} className={className} />;
}

/**
 * Small hexagon for header/topbar — shows agent state at a glance.
 */
export function HeaderHexagon({
  state = "idle",
  className = "",
}: {
  state?: "idle" | "thinking" | "working" | "error";
  className?: string;
}) {
  return <MiniHexagon size={20} state={state} className={className} />;
}

/**
 * Large hexagon for empty state — breathes when idle, reacts to activity.
 */
export function EmptyStateHexagon({
  state = "idle",
  className = "",
}: {
  state?: "idle" | "thinking" | "working" | "error";
  className?: string;
}) {
  return <HexagonMark size={80} state={state} className={className} />;
}

/**
 * Hook to derive hexagon state from agent events.
 * Call this in page.tsx and pass the derived state to LivingHexagon.
 */
export function useHexagonState(events: Array<{ type: string; done?: boolean }>, running: boolean) {
  const [state, setState] = useState<"idle" | "thinking" | "working" | "error">("idle");

  useEffect(() => {
    if (!running) {
      setState("idle");
      return;
    }

    // Check most recent events for state
    const recentEvents = events.slice(-3);
    const hasThinking = recentEvents.some((e) => e.type === "thinking" && !e.done);
    const hasTool = recentEvents.some((e) => e.type === "tool");
    const hasError = recentEvents.some((e) => e.type === "notice" && (e as any).level === "error");

    if (hasError) {
      setState("error");
    } else if (hasThinking) {
      setState("thinking");
    } else if (hasTool || running) {
      setState("working");
    } else {
      setState("idle");
    }
  }, [events, running]);

  return state;
}