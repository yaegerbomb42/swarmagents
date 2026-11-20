"use client";

/**
 * HandoffCard — the inline "Take the Wheel" mini-canvas for a desktop handoff.
 *
 * When the agent calls ask_human_desktop the run pauses and this card appears
 * in the chat stream. It mounts a small noVNC surface dialed against the
 * desktop proxy in control mode, so the user can solve the blocker live
 * (CAPTCHA, 2FA, SSO OAuth, a UI drag). Clicking "Hand Back to Agent" POSTs
 * to /api/runtime/handoffs; the paused run then resumes with a compact
 * post-handoff state summary as the tool result.
 *
 * The card is intentionally self-contained: it owns its own RFB connection
 * (cleaned up on unmount) and reports connect/live/resolved phases locally.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/lib/rfb";
import { Hand, Loader2, RefreshCw } from "lucide-react";
import { desktopWsUrl } from "../../../../lib/client/desktopConfig";

export interface HandoffCardEntry {
  id: string;
  reason: string;
  description: string;
  status: "pending" | "answered" | "cancelled" | "expired";
  expiresAt?: number;
}

interface HandoffCardProps {
  entry: HandoffCardEntry;
  /** Called after a successful hand-back POST (to flip local state). */
  onHandBack?: (id: string) => void;
}

type CardPhase = "connecting" | "live" | "handing-back" | "done";

export function HandoffCard({ entry, onHandBack }: HandoffCardProps) {
  const surfaceHolderRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [phase, setPhase] = useState<CardPhase>("connecting");
  const [error, setError] = useState<string>();

  const pending = entry.status === "pending";
  const resolved = entry.status === "answered";

  // Mount the take-the-wheel RFB surface (control mode) once while pending.
  useEffect(() => {
    if (!pending) return;
    const holder = surfaceHolderRef.current;
    if (!holder) return;
    const target = document.createElement("div");
    holder.replaceChildren();
    holder.appendChild(target);
    let rfb: RFB;
    try {
      rfb = new RFB(target, desktopWsUrl("control"), { shared: true });
    } catch {
      setError("Could not reach the desktop.");
      return;
    }
    rfbRef.current = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = false;
    rfb.viewOnly = false; // the user holds the wheel
    rfb.addEventListener("connect", () => setPhase("live"));
    rfb.addEventListener("disconnect", () => {
      if (rfbRef.current !== rfb) return;
      setPhase("connecting");
    });
    rfb.addEventListener("credentialsrequired", () => {
      if (rfbRef.current === rfb) setError("Desktop auth failed.");
    });
    return () => {
      if (rfbRef.current === rfb) rfbRef.current = null;
      rfb.blur();
      rfb.disconnect();
      holder.replaceChildren();
    };
  }, [pending]);

  const handBack = useCallback(async () => {
    if (!pending || phase === "handing-back") return;
    setPhase("handing-back");
    setError(undefined);
    try {
      const res = await fetch("/api/runtime/handoffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      });
      if (!res.ok) {
        setError("Could not hand the desktop back. Try again.");
        setPhase("live");
        return;
      }
      setPhase("done");
      onHandBack?.(entry.id);
    } catch {
      setError("Could not reach the runtime.");
      setPhase("live");
    }
  }, [pending, phase, entry.id, onHandBack]);

  const disconnected = phase === "connecting" && !error;

  return (
    <div
      data-testid="handoff-card"
      data-handoff-id={entry.id}
      className="rounded-xl border border-amber-400/30 bg-amber-500/[0.07] p-3"
    >
      <div className="flex items-start gap-2">
        <Hand className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-amber-300/80">
            {pending ? "Take the wheel · agent paused" : `Desktop handoff · ${entry.status}`}
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-100">
            {entry.reason}
          </p>
          {entry.description.trim() && (
            <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-400">
              {entry.description}
            </p>
          )}

          {pending && (
            <>
              <div className="relative mt-2 h-40 w-full overflow-hidden rounded-lg border border-white/10 bg-black">
                <div ref={surfaceHolderRef} className="absolute inset-0" data-testid="handoff-canvas" />
                {phase === "connecting" && (
                  <div className="absolute inset-0 grid place-items-center bg-black/70">
                    <div className="flex items-center gap-2 font-mono text-[11px] text-white/60">
                      {disconnected ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 text-amber-300/80" />
                          Connecting to desktop…
                        </>
                      ) : (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-300/80" />
                          Live — solve the blocker, then hand it back.
                        </>
                      )}
                    </div>
                  </div>
                )}
                {error && <div className="absolute inset-x-2 bottom-1.5 text-[11px] text-rose-300">{error}</div>}
              </div>

              <div className="mt-2 flex items-center justify-end gap-2">
                <span className="text-[10.5px] text-zinc-500">
                  Credentials you enter never reach the agent.
                </span>
                <button
                  type="button"
                  data-testid="handoff-handback"
                  disabled={phase !== "live"}
                  onClick={() => void handBack()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 py-1 text-[12px] text-amber-100 transition hover:bg-amber-500/30 disabled:opacity-40"
                >
                  {phase === "handing-back" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Hand className="h-3 w-3" />
                  )}
                  Hand Back to Agent
                </button>
              </div>
            </>
          )}

          {resolved && (
            <p className="mt-2 rounded-lg bg-white/[0.05] px-2 py-1.5 text-[12px] text-zinc-300">
              <span className="text-zinc-500">You: </span>
              The desktop was handed back to the agent.
            </p>
          )}
          {!pending && !resolved && (
            <p className="mt-1 text-[11px] text-zinc-500">
              {entry.status === "expired" ? "This handoff expired." : "The run was cancelled before it was handed back."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default HandoffCard;
