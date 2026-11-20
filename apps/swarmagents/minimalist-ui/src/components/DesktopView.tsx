"use client";

/**
 * DesktopView — the live VM desktop pane of the main-page ComputerScreen.
 *
 * Connects the browser to the desktop VM's VNC web client through the
 * same-origin desktop websocket proxy (see lib/client/desktopConfig.ts for
 * the endpoint contract) using the pinned noVNC client. The RFB surface is
 * mounted in its own contained element — noVNC attaches its input listeners
 * to that element's subtree only — and input is additionally gated by
 * noVNC's viewOnly flag, so "Watch" is a pure read-only mirror.
 *
 * UI states (driven by the pure machine in lib/client/desktopState.ts):
 *
 *   starting      VM booting — "starting VM" overlay on the empty frame
 *   connecting    dialing the proxy — spinner on the empty frame
 *   live          stream up; red LIVE dot + measured fps in the corner
 *   reconnecting  socket dropped; backoff counter after the next retry
 *   offline       fallback to the latest screenshot frame (if any) + retry
 *
 * Controls: Watch (default, input disabled) / Take over / Hand back,
 * Fullscreen, and Reconnect when offline. In control mode a clear
 * "You are in control" banner appears; since there is no run-pause API yet,
 * it warns that a live agent run continues to share the desktop unless
 * stopped (the banner offers the existing stop-run action).
 */

import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Expand, Hand, MousePointerClick, Play, RefreshCw, MonitorPlay } from "lucide-react";
import RFB from "@novnc/novnc/lib/rfb";
import {
  DESKTOP_SCREENSHOT_PATH,
  desktopWsUrl,
  type DesktopMode,
} from "../../../lib/client/desktopConfig";
import {
  describeDesktopPhase,
  INITIAL_DESKTOP_CONN,
  reduceDesktopConn,
  type DesktopControlMode,
  type DesktopPhase,
} from "../../../lib/client/desktopState";
import type { VmDisplayState } from "../../../lib/client/vmStatus";
import { MascotSvg } from "../../../components/mascot/MascotSvg";
import { svgStateForRun } from "../../../components/mascot/svg-timeline";
import { DesktopFpsMeter } from "../utils/desktopFps";

/** Connection facts the ScreenFrame's LIVE pill needs. */
export interface DesktopConnectionInfo {
  phase: DesktopPhase;
  latencyMs?: number;
  fps: number;
  attempt: number;
}

export interface DesktopViewProps {
  /** The VM display state the ComputerScreen already computed for its pill. */
  vmState: VmDisplayState;
  /** True while a VM reset/wipe is in flight. */
  vmResetting?: boolean;
  /** True while an agent run is streaming (adds the takeover warning). */
  runActive?: boolean;
  /** Stop the live agent run from the control-mode banner (optional). */
  onStopRun?: () => void;
  /**
   * Embedded mode fills its parent with just the noVNC surface and state
   * overlays — the ScreenFrame supplies the frame, status pill, controls and
   * control banner.
   */
  embedded?: boolean;
  /**
   * Controlled interaction mode. When provided, DesktopView re-dials the
   * proxy for the new view/control mode and calls `onControlChange` instead
   * of keeping its own switch. Omit to keep the legacy inline controls.
   */
  control?: boolean;
  onControlChange?: (control: boolean) => void;
  /** Reports connection phase/fps/latency changes to the frame pill. */
  onConnection?: (info: DesktopConnectionInfo) => void;
}

const PHASE_OVERLAY_TEXT: Record<string, string> = {
  starting: "Starting VM…",
  connecting: "Connecting to desktop…",
};

export function DesktopView({
  vmState,
  vmResetting = false,
  runActive = false,
  onStopRun,
  embedded = false,
  control,
  onControlChange,
  onConnection,
}: DesktopViewProps) {
  const [conn, dispatch] = useReducer(reduceDesktopConn, INITIAL_DESKTOP_CONN);
  const [internalMode, setInternalMode] = useState<DesktopControlMode>("watch");
  const controlled = control !== undefined;
  const mode: DesktopControlMode = controlled ? (control ? "control" : "watch") : internalMode;
  const [fps, setFps] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number>();
  const [frameSrc, setFrameSrc] = useState<string>();

  // The noVNC surface lives in its own element so its listeners stay scoped
  // away from the rest of the app; the frame box is the visual 16:9 screen.
  const frameRef = useRef<HTMLDivElement>(null);
  const surfaceHolderRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const modeRef = useRef<DesktopControlMode>(mode);
  const meterRef = useRef<DesktopFpsMeter | null>(null);
  const frameUrlRef = useRef<string | undefined>(undefined);
  const dialStartedRef = useRef<number | undefined>(undefined);

  const releaseFrameUrl = useCallback(() => {
    if (frameUrlRef.current) {
      URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = undefined;
    }
  }, []);

  const teardown = useCallback(() => {
    meterRef.current?.stop();
    meterRef.current = null;
    const rfb = rfbRef.current;
    rfbRef.current = null;
    rfb?.blur();
    rfb?.disconnect();
    if (surfaceHolderRef.current && rfb) {
      // noVNC builds its DOM inside the element we handed it.
      surfaceHolderRef.current.replaceChildren();
    }
  }, []);

  // Map the shared VM display state onto the connection machine: "starting"
  // (and hibernated/error) circle the screen at "starting VM"; a ready VM
  // starts dialing — but never interrupts a live socket or a backoff loop.
  useEffect(() => {
    if (vmResetting) return;
    if (vmState === "ready") {
      if (conn.phase === "starting" || conn.phase === "offline") {
        dispatch({ type: "vm-ready" });
      }
      return;
    }
    if (conn.phase !== "live" && conn.phase !== "reconnecting") {
      dispatch({ type: "vm-starting" });
    }
    // conn.phase is intentionally read but not a dependency: the VM status is
    // the trigger, and firing on every phase change would reset the backoff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmState, vmResetting]);

  // Scheduled redial timer for the reconnecting phase.
  useEffect(() => {
    if (conn.phase !== "reconnecting" || conn.retryInMs <= 0) return;
    const timer = setTimeout(
      () => dispatch({ type: "retry-due" }),
      conn.retryInMs,
    );
    return () => clearTimeout(timer);
  }, [conn.phase, conn.retryInMs]);

  // Dial loop: while "connecting", own exactly one RFB instance against the
  // proxy for the current mode.
  useEffect(() => {
    if (conn.phase !== "connecting") return;
    const holder = surfaceHolderRef.current;
    if (!holder) return;
    let opened = false;
    const mode = modeRef.current;
    const target = document.createElement("div");
    holder.replaceChildren();
    holder.appendChild(target);
    let rfb: RFB;
    try {
      // UI mode "watch" is the proxy's wire mode "view" (read-only).
      dialStartedRef.current = performance.now();
      rfb = new RFB(target, desktopWsUrl(mode === "watch" ? "view" : "control"), { shared: true });
    } catch {
      target.remove();
      dispatch({ type: "refused" });
      return undefined;
    }
    rfbRef.current = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = false;
    rfb.viewOnly = mode === "watch";
    rfb.addEventListener("connect", () => {
      opened = true;
      if (dialStartedRef.current !== undefined) {
        setLatencyMs(Math.max(0, Math.round(performance.now() - dialStartedRef.current)));
      }
      dispatch({ type: "open" });
      if (mode === "control") rfb.focus({ preventScroll: true });
    });
    rfb.addEventListener("disconnect", (ev) => {
      if (rfbRef.current !== rfb) return; // stale teardown event — ignore
      const clean = Boolean(ev.detail?.clean);
      // Live socket said goodbye (or the dial failed outright): reconnect
      // with backoff, or fall back offline. teardown() also releases the
      // meter and the surface DOM.
      teardown();
      dispatch(clean && !opened ? { type: "refused" } : { type: "drop" });
    });
    rfb.addEventListener("credentialsrequired", () => {
      // Auth is injected proxy-side; asking the browser for credentials means
      // the contract is broken — treat as a refused dial.
      if (rfbRef.current === rfb) teardown();
      dispatch({ type: "refused" });
    });
    return () => {
      if (rfbRef.current === rfb && !opened) {
        // A dial that never opened is torn down here (unmount, mode switch,
        // or the phase moved on). Live sockets are torn down on their own
        // path (mode switch / reconnect / unmount).
        teardown();
      }
    };
    // teardown is stable; mode is read via the ref so a mode switch re-dials
    // through dispatch (retry-now) instead of re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.phase, teardown]);

  // Offline fallback: fetch the latest screenshot frame once per offline visit.
  useEffect(() => {
    if (conn.phase !== "offline") return;
    let cancelled = false;
    fetch(DESKTOP_SCREENSHOT_PATH, { headers: { Accept: "image/*" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) throw new Error("not an image");
        return blob;
      })
      .then((blob) => {
        if (cancelled) return;
        releaseFrameUrl();
        frameUrlRef.current = URL.createObjectURL(blob);
        setFrameSrc(frameUrlRef.current);
        dispatch({ type: "fallback-frame" });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "no-frame" });
      });
    return () => {
      cancelled = true;
    };
  }, [conn.phase, releaseFrameUrl]);

  // fps meter runs only while live.
  useEffect(() => {
    if (conn.phase !== "live") return;
    const meter = new DesktopFpsMeter();
    meterRef.current = meter;
    meter.start(setFps);
    return () => {
      meter.stop();
      if (meterRef.current === meter) meterRef.current = null;
      setFps(0);
    };
  }, [conn.phase]);

  // Unmount cleanup.
  useEffect(() => () => {
    teardown();
    releaseFrameUrl();
  }, [teardown, releaseFrameUrl]);

  // Controlled mode change (View only ↔ Take over): both are different proxy
  // query params, so keep exactly one dial for the new mode.
  useEffect(() => {
    if (modeRef.current === mode) return;
    modeRef.current = mode;
    teardown();
    dispatch({ type: "retry-now" });
  }, [mode, teardown]);

  // Tell the frame pill what this connection is doing.
  useEffect(() => {
    onConnection?.({ phase: conn.phase, latencyMs, fps, attempt: conn.attempt });
  }, [onConnection, conn.phase, conn.attempt, latencyMs, fps]);

  const switchMode = useCallback((next: DesktopControlMode) => {
    if (next === modeRef.current) return;
    if (controlled) onControlChange?.(next === "control");
    else setInternalMode(next);
  }, [controlled, onControlChange]);

  const onReconnect = useCallback(() => {
    teardown();
    dispatch({ type: "retry-now" });
  }, [teardown]);

  const onFullscreen = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void frame.requestFullscreen().catch(() => {});
    }
  }, []);

  const live = conn.phase === "live";

  // Embedded: fill the ScreenFrame's 16:10 stage with just the surface and
  // the connection-state overlays. The frame owns the pill, mode control,
  // fullscreen and control banner.
  if (embedded) {
    return (
      <div className="relative h-full w-full bg-[#08080c]" data-testid="desktop-view">
        <div ref={surfaceHolderRef} className="absolute inset-0" aria-hidden={!live} />

        {conn.phase === "offline" && conn.hasFrame && frameSrc && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={frameSrc}
            alt="Latest VM desktop frame"
            className="absolute inset-0 h-full w-full object-cover"
            data-testid="desktop-fallback-frame"
          />
        )}

        {(conn.phase === "starting" || conn.phase === "connecting") && (
          <div data-testid="desktop-overlay" className="absolute inset-0 grid place-items-center bg-[#08080c]">
            <div className="flex flex-col items-center gap-2 text-center">
              <MascotSvg state={svgStateForRun("idle")} size={64} />
              <div className="font-mono text-xs text-white/60">Jimmy is waking up your computer.</div>
              <div className="font-mono text-[11px] text-white/35">
                {PHASE_OVERLAY_TEXT[conn.phase] ?? describeDesktopPhase(conn.phase)}
              </div>
            </div>
          </div>
        )}

        {conn.phase === "reconnecting" && (
          <div data-testid="desktop-overlay" className="absolute inset-0 grid place-items-center bg-[#08080c]/85">
            <div className="flex flex-col items-center gap-2 text-center">
              <RefreshCw className="h-5 w-5 animate-spin text-amber-300/80" />
              <div className="font-mono text-xs text-white/70">
                Reconnecting… retry in {Math.ceil(conn.retryInMs / 1000)}s
                <span className="text-white/35"> (attempt {conn.attempt})</span>
              </div>
              <button
                type="button"
                onClick={onReconnect}
                className="mt-1 rounded-full border border-white/15 bg-white/5 px-3 py-1 font-mono text-[11px] text-white/80 hover:bg-white/10"
              >
                Reconnect now
              </button>
            </div>
          </div>
        )}

        {conn.phase === "offline" && (
          <div data-testid="desktop-overlay" className="absolute inset-0 grid place-items-center bg-[#08080c]/85">
            <div className="flex flex-col items-center gap-2 px-6 text-center">
              <span className="font-mono text-xs text-white/60">Desktop offline</span>
              <span className="max-w-[420px] font-mono text-[11px] text-white/35">
                The terminal, browser and files views are unaffected. Take over again when the desktop reconnects.
              </span>
              <button
                type="button"
                onClick={onReconnect}
                className="mt-1 rounded-full border border-white/15 bg-white/5 px-3 py-1 font-mono text-[11px] text-white/80 hover:bg-white/10"
              >
                Reconnect
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="desktop-view">
      {/* Control-mode banner */}
      {mode === "control" && live && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-indigo-400/35 bg-indigo-500/15 px-4 py-2 text-[11px] font-mono text-indigo-200">
          <span className="font-semibold uppercase tracking-wide">You are in control</span>
          <span className="text-indigo-100/80">
            Keyboard and mouse go to the VM.
            {runActive && " The agent run is still streaming and may act on this desktop too."}
          </span>
          {runActive && onStopRun && (
            <button
              type="button"
              onClick={onStopRun}
              className="ml-auto rounded-full border border-indigo-400/40 bg-black/30 px-2.5 py-0.5 text-[10px] font-mono text-indigo-100 transition hover:bg-black/50"
            >
              Stop agent run
            </button>
          )}
        </div>
      )}

      {/* 16:9 screen frame with the glass corner radius */}
      <div className="flex flex-1 items-start justify-center p-3 min-h-0">
        <div
          ref={frameRef}
          className="relative w-full max-w-[960px] overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_10px_40px_rgba(0,0,0,0.6)]"
          style={{ aspectRatio: "16 / 9" }}
        >
          {/* noVNC surface (live) */}
          <div ref={surfaceHolderRef} className="absolute inset-0" aria-hidden={!live} />

          {/* Offline fallback: latest screenshot frame */}
          {conn.phase === "offline" && conn.hasFrame && frameSrc && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={frameSrc}
              alt="Latest VM desktop frame"
              className="absolute inset-0 h-full w-full object-cover"
              data-testid="desktop-fallback-frame"
            />
          )}

          {/* Non-live overlays: starting / connecting / reconnecting / offline-empty */}
          {(conn.phase === "starting" || conn.phase === "connecting") && (
            <div
              data-testid="desktop-overlay"
              className="absolute inset-0 grid place-items-center bg-[#08080c]"
            >
              <div className="flex flex-col items-center gap-3 text-center">
                <MonitorPlay className="h-6 w-6 text-indigo-400/70 animate-pulse" />
                <div className="text-xs font-mono text-white/60">
                  {PHASE_OVERLAY_TEXT[conn.phase] ?? describeDesktopPhase(conn.phase)}
                </div>
              </div>
            </div>
          )}
          {conn.phase === "reconnecting" && (
            <div data-testid="desktop-overlay" className="absolute inset-0 grid place-items-center bg-[#08080c]/85">
              <div className="flex flex-col items-center gap-2 text-center">
                <RefreshCw className="h-5 w-5 animate-spin text-amber-300/80" />
                <div className="text-xs font-mono text-white/70">
                  Reconnecting… retry in {Math.ceil(conn.retryInMs / 1000)}s
                  <span className="text-white/35"> (attempt {conn.attempt})</span>
                </div>
                <button
                  type="button"
                  onClick={onReconnect}
                  className="mt-1 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-mono text-white/80 hover:bg-white/10"
                >
                  Reconnect now
                </button>
              </div>
            </div>
          )}
          {conn.phase === "offline" && !conn.hasFrame && (
            <div data-testid="desktop-overlay" className="absolute inset-0 grid place-items-center bg-[#08080c]">
              <div className="flex flex-col items-center gap-2 px-6 text-center">
                <span className="text-xs font-mono text-white/50">
                  Desktop offline{mode === "control" ? "" : " · watch-only preview unavailable"}
                </span>
                <span className="text-[11px] font-mono text-white/30">
                  Running with desktop mode off? The terminal, browser and files tabs are unaffected.
                </span>
              </div>
            </div>
          )}

          {/* LIVE badge: red dot + fps while streaming */}
          {live && (
            <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10px] text-white/85">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" data-testid="desktop-live-dot" />
              LIVE
              <span className="text-white/45">{fps} fps</span>
            </div>
          )}
        </div>
      </div>

      {/* Controls row — on mobile the labels collapse into icons (screen stays first). */}
      <div className="flex items-center justify-center gap-2 border-t border-white/10 bg-[#0a0a10] px-3 py-2">
        {mode === "watch" ? (
          <>
            <span
              aria-current={mode === "watch"}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-mono text-white/80"
              data-testid="desktop-mode-watch"
            >
              <Play className="h-3 w-3 shrink-0 sm:mr-0" />
              <span className="hidden sm:inline">Watch</span>
            </span>
            <button
              type="button"
              onClick={() => switchMode("control")}
              title="Take over — drive the VM desktop yourself"
              aria-label="Take over"
              data-testid="desktop-takeover-button"
              className="inline-flex items-center gap-1.5 rounded-full border border-indigo-400/35 bg-indigo-500/15 px-2.5 py-1 text-[11px] font-mono text-indigo-200 transition hover:bg-indigo-500/25"
            >
              <MousePointerClick className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline">Take over</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => switchMode("watch")}
            title="Hand back — return to the read-only view"
            aria-label="Hand back"
            data-testid="desktop-handback-button"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] font-mono text-white/85 transition hover:bg-white/20"
          >
            <Hand className="h-3 w-3 shrink-0" />
            <span className="hidden sm:inline">Hand back</span>
          </button>
        )}

        {(!live || conn.phase === "offline" || conn.phase === "reconnecting") && (
          <button
            type="button"
            onClick={onReconnect}
            title="Try to reconnect the desktop stream"
            aria-label="Reconnect desktop"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-mono text-white/70 transition hover:bg-white/10"
          >
            <RefreshCw className="h-3 w-3 shrink-0" />
            <span className="hidden sm:inline">Reconnect</span>
          </button>
        )}

        <span className="hidden flex-1 sm:block" />
        <span aria-live="polite" className="hidden text-[10px] font-mono text-white/30 sm:inline">
          {describeDesktopPhase(conn.phase)}
          {conn.retryInMs > 0 ? ` · ${Math.ceil(conn.retryInMs / 1000)}s` : ""}
        </span>
        <button
          type="button"
          onClick={onFullscreen}
          title="Fullscreen"
          aria-label="Fullscreen"
          data-testid="desktop-fullscreen-button"
          className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-mono text-white/70 transition hover:bg-white/10"
        >
          <Expand className="h-3 w-3 shrink-0" />
          <span className="hidden sm:inline">Fullscreen</span>
        </button>
      </div>
    </div>
  );
}
