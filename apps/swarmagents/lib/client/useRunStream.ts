"use client";

/**
 * useRunStream(runId) — consume /api/runtime/stream/[runId] (SSE).
 *
 * Decodes the runtime's event stream with the shared SseParser and hands the
 * decoded events to any view that wants them. The stream is resilient:
 *
 *   - it resumes from the last seen `id:` via the Last-Event-ID header, so a
 *     dropped connection loses no events (the server replays from that seq);
 *   - it reconnects with exponential backoff (500ms doubling, capped at 30s),
 *     resetting the clock whenever traffic actually arrives;
 *   - it caps the retained item list at MAX_LINES (oldest dropped first);
 *   - it aborts cleanly on unmount / runId change, and holding no state when
 *     runId is absent lets callers fall back to their simulated logs.
 *
 * Data payloads that parse as JSON are exposed decoded; otherwise the raw
 * string is kept.
 */

import { useEffect, useRef, useState } from "react";
import { backoffDelayMs } from "./backoff";
import { SseParser, type SseMessage } from "./sse";

export type RunStreamStatus = "idle" | "connecting" | "connected" | "reconnecting";

export interface RunStreamItem {
  /** Monotonic display order (mirrors the server seq when ids are numeric). */
  seq: number;
  /** Event type (the `event:` field, defaulting to "message"). */
  kind: string;
  /** JSON-decoded payload when possible, else the raw string. */
  data: unknown;
  /** The original parsed SSE message, for callers that need raw fields. */
  parsed: SseMessage;
  ts: number;
}

export interface RunStreamState {
  status: RunStreamStatus;
  items: RunStreamItem[];
  error?: string;
  /** 1-based reconnect attempt while status is reconnecting; 0 otherwise. */
  reconnectAttempt: number;
}

export type RunStreamBadgeTone = "connecting" | "live" | "reconnecting" | "ended" | "error";

export interface RunStreamBadge {
  label: string;
  tone: RunStreamBadgeTone;
}

/** Events after which a run will emit nothing else, so the stream is done. */
export function isTerminalRunEvent(kind: string): boolean {
  return kind === "run.finished" || kind === "run.error" || kind === "run.cancelled" || kind === "run.paused";
}

function isTerminalEnd(item: RunStreamItem | undefined): boolean {
  if (!item) return false;
  return (
    item.kind === "run.finished" || item.kind === "run.cancelled" || item.kind === "run.paused"
  );
}

export type RunMode = "gui" | "text" | "chat";

export interface RunModeBadge {
  mode: RunMode;
  label: string;
  reason?: string;
}

function asRunMode(value: unknown): RunMode | null {
  return value === "gui" || value === "text" || value === "chat" ? value : null;
}

/**
 * The capability-selected run mode from the newest `run.mode` (or the mode
 * fields on `run.created`). The UI uses this to explain why desktop tools are
 * unavailable for a text-only model.
 */
export function getRunMode(state: Pick<RunStreamState, "items">): RunModeBadge | null {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind !== "run.mode" && item.kind !== "run.created") continue;
    const data = item.data;
    if (!data || typeof data !== "object") continue;
    const record = data as Record<string, unknown>;
    const mode = asRunMode(record.mode);
    if (!mode) continue;
    return {
      mode,
      label: typeof record.modeLabel === "string" ? record.modeLabel : typeof record.label === "string" ? record.label : mode,
      ...(typeof record.modeReason === "string"
        ? { reason: record.modeReason }
        : typeof record.reason === "string"
          ? { reason: record.reason }
          : {}),
    };
  }
  return null;
}

export function getRunStreamBadge(state: Pick<RunStreamState, "status" | "items" | "error" | "reconnectAttempt">): RunStreamBadge {
  const last = state.items[state.items.length - 1];
  if (last?.kind === "run.error") return { label: "error", tone: "error" };
  if (last?.kind === "run.paused") return { label: "paused", tone: "ended" };
  if (isTerminalEnd(last)) return { label: "ended", tone: "ended" };

  switch (state.status) {
    case "idle":
      return { label: "idle", tone: "ended" };
    case "connecting":
      return { label: "connecting", tone: "connecting" };
    case "connected":
      return { label: "live", tone: "live" };
    case "reconnecting": {
      const n = Math.max(1, state.reconnectAttempt || 1);
      return { label: `reconnecting (attempt ${n})`, tone: "reconnecting" };
    }
    default:
      return state.error ? { label: "error", tone: "error" } : { label: "connecting", tone: "connecting" };
  }
}

const MAX_LINES = 2000;
const DEFAULT_EVENT = "message";

/**
 * A cursor (buffered events + Last-Event-ID) must only be kept when the same
 * run is remounted (React StrictMode). Switching runs starts a fresh stream,
 * otherwise the new run is asked to resume a sequence it never emitted and
 * its early events are filtered out as already seen.
 */
export function shouldResetStreamCursor(
  cursorRunId: string | null | undefined,
  nextRunId: string | null | undefined,
): boolean {
  return cursorRunId !== nextRunId;
}

export function useRunStream(runId?: string | null): RunStreamState {
  const [status, setStatus] = useState<RunStreamStatus>("idle");
  const [error, setError] = useState<string>();
  const [items, setItems] = useState<RunStreamItem[]>([]);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  // Refs survive React StrictMode effect remounts, so a remount reconnects
  // with Last-Event-ID instead of replaying every buffered event.
  const itemsRef = useRef<RunStreamItem[]>([]);
  const lastIdRef = useRef<string | undefined>(undefined);
  const seqRef = useRef(0);
  const cursorRunIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const switched = shouldResetStreamCursor(cursorRunIdRef.current, runId);
    cursorRunIdRef.current = runId;
    if (switched) {
      // Never carry one run's transcript into another: a restored run gives
      // way to a new run as soon as it starts in the same page.
      itemsRef.current = [];
      lastIdRef.current = undefined;
      seqRef.current = 0;
      setItems([]);
      setError(undefined);
      setReconnectAttempt(0);
    }

    if (!runId) {
      setStatus("idle");
      return;
    }

    const outer = new AbortController();
    let alive = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const parser = new SseParser();

    const pushItem = (kind: string, data: unknown, parsed: SseMessage) => {
      // A read can resolve in the same tick the effect is torn down; don't let
      // the previous run append into the next run's fresh buffer.
      if (!alive) return;
      const item: RunStreamItem = {
        seq: ++seqRef.current,
        kind,
        data,
        parsed,
        ts: Date.now(),
      };
      const next = [...itemsRef.current, item];
      if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
      itemsRef.current = next;
      setItems(next);
      if (parsed.id) lastIdRef.current = parsed.id;
      attempt = 0; // any live traffic resets the backoff clock
    };

    const connect = async () => {
      if (!alive) return;
      const headers: Record<string, string> = {};
      if (lastIdRef.current) headers["Last-Event-ID"] = lastIdRef.current;
      const reconnecting = attempt > 0;
      setStatus(reconnecting ? "reconnecting" : "connecting");
      setReconnectAttempt(reconnecting ? attempt : 0);
      try {
        const res = await fetch(`/api/runtime/stream/${encodeURIComponent(runId)}`, {
          headers,
          signal: outer.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream responded ${res.status}`);
        setStatus("connected");
        setError(undefined);
        setReconnectAttempt(0);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sawTerminal = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const messages = parser.push(decoder.decode(value, { stream: true }));
          for (const m of messages) {
            const kind = m.event || DEFAULT_EVENT;
            let data: unknown = m.data;
            if (m.data) {
              try {
                data = JSON.parse(m.data);
              } catch {
                /* keep the raw string */
              }
            }
            pushItem(kind, data, m);
            if (isTerminalRunEvent(kind)) sawTerminal = true;
          }
          if (sawTerminal) {
            // The run is over: stop reading instead of waiting for a close
            // and never auto-reconnect (there is nothing left to resume).
            await reader.cancel().catch(() => {});
            break;
          }
        }
        // A terminal run ends the stream cleanly; anything else is a dropped
        // connection (proxy timeout, server close) worth retrying.
        if (sawTerminal) return;
        throw new Error("stream closed");
      } catch (err) {
        if (!alive || outer.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        const delayMs = backoffDelayMs(attempt);
        attempt += 1;
        setReconnectAttempt(attempt);
        timer = setTimeout(() => void connect(), delayMs);
      }
    };

    void connect();

    return () => {
      alive = false;
      outer.abort();
      if (timer) clearTimeout(timer);
      setStatus("idle");
      setReconnectAttempt(0);
    };
  }, [runId]);

  return { status, items, error, reconnectAttempt };
}
