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
import { clearSessionValue, readSessionValue, writeSessionValue } from "./storage";

export type RunStreamStatus = "idle" | "connecting" | "connected" | "reconnecting";

/** Server-minted run ids: 1-64 alphanumerics, `_` or `-`. Twin of the
 * server-side RUN_ID_RE in lib/telemetry/paths.ts (kept separate: that
 * module imports node builtins, which client code must not pull in). */
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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

export type RunMode = "gui" | "text" | "text-desktop" | "chat";

export interface RunModeBadge {
  mode: RunMode;
  label: string;
  reason?: string;
}

function asRunMode(value: unknown): RunMode | null {
  return value === "gui" || value === "text" || value === "text-desktop" || value === "chat" ? value : null;
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
/** Upper bound on the buffered items once a truncated replay is backfilled. */
const BACKFILL_MAX_ITEMS = 10_000;
const DEFAULT_EVENT = "message";

/**
 * The first event id of a truncated replay, from the server's `run.snapshot`
 * announcement (seq 0, `data: { truncated: true, firstEventId, ... }`), or
 * null when the replay is complete. The snapshot sorts before every real
 * event, so it is the first item when present.
 */
export function snapshotTruncation(items: readonly RunStreamItem[]): number | null {
  for (const item of items) {
    if (item.kind !== "run.snapshot") continue;
    const data = item.data;
    if (!data || typeof data !== "object") return null;
    const record = data as { truncated?: unknown; firstEventId?: unknown };
    if (record.truncated !== true) return null;
    return typeof record.firstEventId === "number" && Number.isFinite(record.firstEventId)
      ? record.firstEventId
      : null;
  }
  return null;
}

/**
 * Parse the NDJSON run log (`GET /api/runtime/runs/[id]/log`: one persisted
 * event per line, oldest first) into stream items. Lines without a numeric
 * seq or a string type are legacy noise and are skipped. Item seqs come from
 * the log's own sequence numbers so the backfilled head orders before the
 * replayed tail; the live stream's local counter takes over after that.
 */
export function parseRunLogNdjson(text: string): RunStreamItem[] {
  const items: RunStreamItem[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const record = event as { seq?: unknown; type?: unknown; ts?: unknown; data?: unknown };
    if (typeof record.seq !== "number" || !Number.isFinite(record.seq)) continue;
    if (typeof record.type !== "string" || !record.type) continue;
    items.push({
      seq: record.seq,
      kind: record.type,
      data: record.data,
      parsed: { data: trimmed, event: record.type, id: String(record.seq) },
      ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : Date.now(),
    });
  }
  return items;
}

/**
 * Fill in the head a capped replay omitted, from the persisted log.
 * Returns null when there is nothing to fill (no truncated snapshot, or the
 * log holds no events below the replay window). Otherwise the logged events
 * below firstEventId are prepended (in log order) and the snapshot item is
 * dropped — the view is complete, so the "showing recent events" note clears.
 * When the merged history would exceed maxItems the backfill is refused
 * (null) instead of silently dropping the head again; the snapshot stays and
 * the capped tail remains the view.
 */
export function backfillTruncatedItems(
  current: readonly RunStreamItem[],
  logged: readonly RunStreamItem[],
  maxItems: number = BACKFILL_MAX_ITEMS,
): { items: RunStreamItem[]; complete: boolean } | null {
  const firstEventId = snapshotTruncation(current);
  if (firstEventId === null) return null;
  const missing = logged.filter((item) => item.seq < firstEventId);
  const rest = current.filter((item) => item.kind !== "run.snapshot");
  const mergedCount = missing.length + rest.length;
  if (mergedCount > maxItems) return null;
  // Item seqs are the live stream's local counter, not the server's: renumber
  // the backfilled head so its seqs are unique and sort before the replayed
  // tail (the server seq survives in parsed.id).
  const anchor = rest[0]?.seq ?? 0;
  const renumbered = missing.map((item, index) => ({
    ...item,
    seq: anchor - missing.length + index,
  }));
  return { items: [...renumbered, ...rest], complete: true };
}

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

/**
 * Last-Event-ID cursor persisted per run in sessionStorage so a full page
 * reload resumes the stream where it left off instead of replaying from
 * seq 0 (which caps at the server's INITIAL_REPLAY_CAP and drops the head
 * of a long trajectory). Tab-scoped: closing the tab drops the cursors, and
 * a finished run's cursor is cleared when its terminal event arrives.
 * All helpers tolerate a missing or blocked storage (SSR, private mode):
 * the in-memory cursor still works for the lifetime of the page.
 */
export function sseCursorKey(runId: string): string {
  return `swarm:sse-cursor:${runId}`;
}

export function readSseCursor(runId: string): string | undefined {
  return readSessionValue(sseCursorKey(runId));
}

export function writeSseCursor(runId: string, id: string): void {
  writeSessionValue(sseCursorKey(runId), id);
}

export function clearSseCursor(runId: string): void {
  clearSessionValue(sseCursorKey(runId));
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
  // A truncated replay is backfilled from the persisted log once per run.
  const backfillStartedRef = useRef(false);

  useEffect(() => {
    const switched = shouldResetStreamCursor(cursorRunIdRef.current, runId);
    cursorRunIdRef.current = runId;
    if (switched) {
      // Never carry one run's transcript into another: a restored run gives
      // way to a new run as soon as it starts in the same page.
      itemsRef.current = [];
      lastIdRef.current = undefined;
      seqRef.current = 0;
      backfillStartedRef.current = false;
      setItems([]);
      setError(undefined);
      setReconnectAttempt(0);
    }
    // A full page reload loses the in-memory cursor but the run itself is
    // restored from the server (same runId): resume from the persisted
    // cursor so a long trajectory does not replay from seq 0. A run
    // visited before in this tab resumes from its stored cursor too.
    if (!lastIdRef.current && runId) lastIdRef.current = readSseCursor(runId);

    if (!runId) {
      setStatus("idle");
      return;
    }

    // The run id lands in the stream URL, so only a server-minted shape may
    // reach the fetch: anything else (e.g. a poisoned storage hint) is
    // refused instead of being interpolated into a request (Sonar S8476).
    if (!RUN_ID_RE.test(runId)) {
      setError("Invalid run id.");
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
      if (parsed.id) {
        lastIdRef.current = parsed.id;
        if (runId) writeSseCursor(runId, parsed.id);
      }
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
        let terminalKind: string | undefined;
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
            // The server announces a capped replay with a `run.snapshot`
            // (truncated: true). Fill in the omitted head from the persisted
            // log so a long run's timeline is complete, not a tail with a
            // note. A failed fetch leaves the snapshot (and its note) in place.
            if (
              kind === "run.snapshot" &&
              !backfillStartedRef.current &&
              typeof data === "object" &&
              data !== null &&
              (data as { truncated?: unknown }).truncated === true
            ) {
              backfillStartedRef.current = true;
              void (async () => {
                try {
                  const res = await fetch(`/api/runtime/runs/${encodeURIComponent(runId)}/log`, {
                    signal: outer.signal,
                  });
                  if (!res.ok) return;
                  const text = await res.text();
                  if (!alive) return;
                  const merged = backfillTruncatedItems(itemsRef.current, parseRunLogNdjson(text));
                  if (!merged) return;
                  itemsRef.current = merged.items;
                  setItems(merged.items);
                } catch {
                  // The capped tail stays; the snapshot note stays honest.
                }
              })();
            }
            if (isTerminalRunEvent(kind)) {
              sawTerminal = true;
              terminalKind = kind;
            }
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
        if (sawTerminal) {
          // The run is over: drop its persisted cursor so a later revisit
          // replays the (capped) run from the start. A paused run keeps
          // its cursor — it can resume and keep emitting.
          if (runId && terminalKind !== "run.paused") clearSseCursor(runId);
          return;
        }
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
