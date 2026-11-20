"use client";

/**
 * LiveRoomClient — the live half of a share link. A guest sees the owner's
 * streaming run telemetry (read-only SSE) and the owner's read-only noVNC
 * desktop, and can drop a prompt suggestion that the owner may run.
 *
 * All backend access is token-gated; the client never holds or sends the
 * owner's identity. The desktop connection requests `mode=view` and the proxy
 * enforces view-only for guests regardless of what the client sends.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/lib/rfb";
import { DESKTOP_WS_PATH } from "@/lib/client/desktopConfig";

const MAX_EVENTS = 120;
const MAX_SUGGESTION_LEN = 8000;

/** Telemetry event types surfaced on the read-only feed. */
const EVENT_TYPES = [
  "run.created",
  "run.queued",
  "run.finished",
  "run.error",
  "run.cancelled",
  "run.paused",
  "run.snapshot",
  "stream.error",
] as const;

interface RoomRun {
  runId: string;
  status: string;
  prompt?: string;
  position?: number;
}

interface RoomState {
  live: boolean;
  projectId: string;
  run: RoomRun | null;
  suggestions: { count: number; limit: number };
}

interface RoomEvent {
  id: string;
  type: string;
  data: unknown;
  ts: number;
}

type DesktopPhase = "idle" | "connecting" | "live" | "error";

function shortLabel(type: string): string {
  return type.replace(/^run\./, "").replace(/\./g, " ");
}

export function LiveRoomClient({ token }: { token: string }) {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [suggestText, setSuggestText] = useState("");
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [desktopPhase, setDesktopPhase] = useState<DesktopPhase>("idle");
  const [desktopError, setDesktopError] = useState<string | null>(null);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const openedRef = useRef(false);

  const streamUrl = `/api/share/${encodeURIComponent(token)}/stream`;
  const suggestUrl = `/api/share/${encodeURIComponent(token)}/suggest`;

  const pushEvent = useCallback((type: string, data: unknown, ts: number, id: string) => {
    setEvents((prev) => {
      const next = [...prev, { id, type, data, ts }];
      return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
    });
  }, []);

  // Load room state.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<RoomState>;
      })
      .then((state) => {
        if (!cancelled) setRoom(state);
      })
      .catch(() => {
        if (!cancelled) setRoomError("This share link could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Read-only SSE subscription while the room is live.
  useEffect(() => {
    if (!room?.live) return;
    const es = new EventSource(streamUrl);
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev: MessageEvent) => {
        let payload: unknown = ev.data;
        try {
          payload = JSON.parse(ev.data);
        } catch {
          /* keep raw string */
        }
        pushEvent(type, payload, Date.now(), String(ev.lastEventId ?? Date.now()));
      });
    }
    es.addEventListener("error", () => {
      // EventSource auto-reconnects; only surface a hard failure once the
      // stream is actually closed (no auto-reconnect for explicit errors).
    });
    return () => es.close();
  }, [room?.live, streamUrl, pushEvent]);

  // Read-only noVNC desktop, gated behind a live room.
  useEffect(() => {
    if (!room?.live) {
      rfbRef.current?.disconnect();
      rfbRef.current = null;
      setDesktopPhase("idle");
      return;
    }
    const target = surfaceRef.current;
    if (!target) return;
    let disposed = false;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}${DESKTOP_WS_PATH}?mode=view&token=${encodeURIComponent(token)}`;

    setDesktopPhase("connecting");
    let rfb: RFB;
    try {
      rfb = new RFB(target, wsUrl, { shared: true });
    } catch {
      setDesktopPhase("error");
      return;
    }
    rfbRef.current = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = false;
    rfb.viewOnly = true; // belt-and-suspenders; the proxy also enforces view.

    rfb.addEventListener("connect", () => {
      if (disposed) return;
      openedRef.current = true;
      setDesktopPhase("live");
      setDesktopError(null);
    });
    rfb.addEventListener("disconnect", () => {
      if (disposed) return;
      setDesktopPhase(openedRef.current ? "error" : "idle");
      if (openedRef.current) setDesktopError("Desktop stream disconnected.");
    });
    rfb.addEventListener("credentialsrequired", () => {
      if (disposed) return;
      setDesktopPhase("error");
      setDesktopError("Desktop authentication failed.");
    });

    return () => {
      disposed = true;
      rfbRef.current = null;
      rfb.blur();
      rfb.disconnect();
      if (target) target.replaceChildren();
    };
  }, [room?.live, token]);

  const submitSuggestion = async () => {
    const text = suggestText.trim();
    if (!text) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const res = await fetch(suggestUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSuggestError(body.error ?? "Could not send suggestion.");
        return;
      }
      setSuggestText("");
      const fresh = await fetch(`/api/share/${encodeURIComponent(token)}`).then((r) => r.json() as Promise<RoomState>);
      setRoom(fresh);
    } catch {
      setSuggestError("Network error. Please try again.");
    } finally {
      setSuggesting(false);
    }
  };

  const live = room?.live ?? false;
  const cap = room?.suggestions.limit ?? 3;
  const used = room?.suggestions.count ?? 0;

  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-2">
      {/* Live stream */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Live run</h2>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] ${
              live ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-white/10 bg-white/5 text-white/40"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400 animate-pulse" : "bg-white/30"}`} />
            {live ? `LIVE · ${room?.run?.status ?? ""}` : "offline"}
          </span>
        </div>

        {roomError ? (
          <p className="mt-3 text-sm text-rose-300">{roomError}</p>
        ) : live ? (
          <>
            <p className="mt-3 break-all font-mono text-[12px] text-white/70">
              {room?.run?.prompt}
              {room?.run?.position !== undefined ? ` (queued #${room.run.position})` : ""}
            </p>
            <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {events.length === 0 && (
                <p className="text-xs text-white/40">Waiting for the first event…</p>
              )}
              {events.map((ev) => (
                <div key={`${ev.id}-${ev.ts}`} className="flex items-baseline gap-2 font-mono text-[11px]">
                  <span className="shrink-0 text-cyan-300/60">{shortLabel(ev.type)}</span>
                  <span className="shrink-0 text-white/30">
                    {new Date(ev.ts).toLocaleTimeString("en-US", { hour12: false })}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-white/55">
                    {typeof ev.data === "object" && ev.data !== null
                      ? JSON.stringify((ev.data as Record<string, unknown>).prompt ?? ev.data).slice(0, 120)
                      : String(ev.data)}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-3 text-sm text-white/40">
            No agent run is active right now. When the owner starts one, it streams here live.
          </p>
        )}
      </section>

      {/* Read-only desktop + suggestions */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Desktop (read-only)</h2>
        <div className="mt-3 aspect-video w-full overflow-hidden rounded-xl border border-white/10 bg-black">
          <div ref={surfaceRef} className="h-full w-full" aria-hidden={desktopPhase !== "live"} />
          {desktopPhase !== "live" && (
            <div className="grid h-full w-full place-items-center px-4 text-center">
              <div>
                <p className="font-mono text-xs text-white/60">
                  {desktopPhase === "connecting" ? "Connecting to desktop…" : desktopPhase === "error" ? "Desktop unavailable" : "Desktop preview"}
                </p>
                {desktopError && <p className="mt-1 text-[11px] text-rose-300/80">{desktopError}</p>}
                {!live && <p className="mt-1 text-[11px] text-white/35">Requires a live room.</p>}
              </div>
            </div>
          )}
        </div>

        <h3 className="mt-4 text-[10px] uppercase tracking-wide text-white/40">
          Suggest a prompt ({used}/{cap})
        </h3>
        <textarea
          value={suggestText}
          onChange={(e) => setSuggestText(e.target.value)}
          maxLength={MAX_SUGGESTION_LEN}
          placeholder="Suggest a next step for the owner to run…"
          className="mt-2 h-20 w-full resize-none rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-[12px] text-white/85 outline-none placeholder:text-white/25 focus:border-cyan-400/40"
        />
        {suggestError && <p className="mt-1 text-[11px] text-rose-300">{suggestError}</p>}
        <div className="mt-2 flex items-center justify-between">
          <p className="text-[10px] text-white/30">Suggestions wait for the owner to run them.</p>
          <button
            type="button"
            onClick={submitSuggestion}
            disabled={suggesting || !suggestText.trim() || used >= cap}
            className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-mono text-cyan-200 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {suggesting ? "Sending…" : "Suggest"}
          </button>
        </div>
      </section>
    </div>
  );
}
