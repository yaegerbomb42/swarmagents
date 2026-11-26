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
import { Expand, Hand, MousePointerClick, Play, RefreshCw } from "lucide-react";
import RFB from "@novnc/novnc/lib/rfb";
import {
  DESKTOP_SCREENSHOT_PATH,
  desktopTakeoverStateUrl,
  desktopWsUrl,
  type DesktopMode,
} from "../../../lib/client/desktopConfig";
import {
  controlModeForTakeoverState,
  describeDesktopPhase,
  INITIAL_DESKTOP_CONN,
  reduceDesktopConn,
  type DesktopControlMode,
  type DesktopPhase,
  type ServerTakeoverState,
} from "../../../lib/client/desktopState";
import type { VmDisplayState } from "../../../lib/client/vmStatus";
import { presenceHintRegion, type ComputerAction, type Presence } from "../../../lib/client/presence";
import { ComputerActionOverlay } from "./ComputerActionOverlay";
import { DesktopFpsMeter } from "../utils/desktopFps";
import { GLASS } from "../design/vm-tokens";
import { cn } from "../utils/cn";

/** Connection facts the ScreenFrame's LIVE pill needs. */
export interface DesktopConnectionInfo {
  phase: DesktopPhase;
  latencyMs?: number;
  fps: number;
  attempt: number;
  /**
   * Effective takeover mode for this client: "requested" while the server
   * holds the request for the agent's safe point, "control" once granted.
   */
  takeover: DesktopControlMode;
}

export interface DesktopViewProps {
  /** The VM display state the ComputerScreen already computed for its pill. */
  vmState: VmDisplayState;
  /** True while a VM reset/wipe is in flight. */
  vmResetting?: boolean;
  /** True while an agent run is streaming (adds the takeover warning). */
  runActive?: boolean;
  /** Run to tag this viewer's session with, so its frames can be replayed. */
  runId?: string;
  /**
   * The agent whose desktop this view shows (default "a1"). The proxy dials
   * that agent's own VM; omit for A1's desktop (the per-user VM).
   */
  agentId?: string;
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
  /**
   * What the agent is doing right now. The desktop paints a soft, blurred
   * tint over the region a change most plausibly happened in (see
   * presenceHintRegion) and fades it out when the agent stops — "where the
   * agent is" without claiming pixel accuracy the harness does not provide.
   */
  presence?: Presence;
  /**
   * The agent's latest computer-use action (see deriveComputerAction). The
   * desktop paints a click ripple / cursor reticle at the action's
   * framebuffer coordinates plus a floating HUD chip naming it — in both the
   * embedded and the standalone view. The overlay is pointer-events-none,
   * so it can never intercept a human takeover.
   */
  computerAction?: ComputerAction;
  /** Epoch ms of the newest watchdog.loop nudge; flashes the action chip. */
  loopNudgeAt?: number;
  /** The frame's Take over button controls interaction; shown on the overlay. */
  canControl?: boolean;
  /** Detail from a vm.error event, for the booting overlay's error copy. */
  vmErrorMessage?: string;
}

const PHASE_OVERLAY_TEXT: Record<string, string> = {
  starting: "Starting VM…",
  connecting: "Connecting to desktop…",
};

/**
 * Copy for the booting overlay, by VM state and dial phase. The overlay used
 * to say "Starting VM…" for every non-ready state — including a hibernated
 * VM waking up and a VM that reported an error. The words now name the
 * actual state, so a wake-up does not read as a first boot.
 */
export function bootingOverlayCopy(
  vmState: VmDisplayState,
  phase: DesktopPhase,
  errorMessage?: string,
): { title: string; detail: string } {
  if (phase === "connecting") {
    return { title: "Connecting to desktop", detail: "Dialing your computer's screen…" };
  }
  switch (vmState) {
    case "hibernated":
      return {
        title: "Waking your computer",
        detail: "Hibernated after being idle — starting it back up…",
      };
    case "error":
      return {
        title: "Computer error",
        detail: errorMessage ?? "Something went wrong — try resetting the computer.",
      };
    case "starting":
    case "ready":
    default:
      return { title: "Waking up your computer.", detail: PHASE_OVERLAY_TEXT.starting };
  }
}

/**
 * The booting state: a glass card over a dimmed stage with a skeleton of
 * the desktop that is about to appear (menu bar + window), so the empty
 * screen reads as "a computer is starting" instead of a black box. The
 * shimmer is indeterminate — it never pretends to know a percentage.
 * Shared by the embedded and standalone paths so the two cannot drift.
 */
export function DesktopBootingOverlay({
  vmState,
  phase,
  errorMessage,
}: {
  vmState: VmDisplayState;
  phase: DesktopPhase;
  errorMessage?: string;
}) {
  const copy = bootingOverlayCopy(vmState, phase, errorMessage);
  return (
    <div
      data-testid="desktop-overlay"
      className="absolute inset-0 z-20 grid place-items-center bg-black/70 backdrop-blur-[2px]"
    >
      <div className={cn(GLASS.panel, "flex w-[min(320px,86%)] flex-col items-center gap-3 px-6 py-5 text-center")}>
        <div
          aria-hidden
          data-testid="desktop-boot-skeleton"
          className="w-40 animate-pulse rounded-xl border border-white/10 bg-white/[0.04] p-2"
        >
          <div className="flex items-center gap-1 border-b border-white/10 pb-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400/60" />
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400/60" />
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/60" />
            <span className="ml-auto h-1.5 w-10 rounded-full bg-white/10" />
          </div>
          <div className="space-y-1.5 pt-2">
            <div className="h-1.5 w-3/4 rounded-full bg-white/10" />
            <div className="h-1.5 w-1/2 rounded-full bg-white/[0.07]" />
          </div>
        </div>
        <div className="font-mono text-xs text-white/70">{copy.title}</div>
        <div className="font-mono text-[11px] text-white/40">{copy.detail}</div>
      </div>
    </div>
  );
}

/** A centered glass card over the stage, for the reconnecting/offline states. */
function DesktopOverlayCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="desktop-overlay"
      className="absolute inset-0 z-20 grid place-items-center bg-black/60 backdrop-blur-[2px]"
    >
      <div className={cn(GLASS.panel, "flex w-[min(360px,86%)] flex-col items-center gap-2 px-6 py-5 text-center")}>
        {children}
      </div>
    </div>
  );
}

/**
 * The presence tint over the live desktop. The region comes from
 * presenceHintRegion (a coarse guess, deliberately), the intensity from the
 * run state: working breathes, waiting holds steady and warmer, idle paints
 * nothing at all. `pointer-events-none` keeps every pixel clickable through
 * it, and a CSS opacity transition makes it appear/disappear with the run
 * rather than snapping.
 */
export function PresenceGlow({ presence }: { presence?: Presence }) {
  const region = presence ? presenceHintRegion(presence) : null;
  if (!presence || !region || presence.runState === "idle") return null;
  const waiting = presence.runState === "waiting";
  return (
    <div
      aria-hidden
      data-testid="desktop-presence-glow"
      data-run-state={presence.runState}
      className="pointer-events-none absolute z-[5] rounded-3xl transition-opacity duration-700"
      style={{
        left: `${(region.x / 1280) * 100}%`,
        top: `${(region.y / 800) * 100}%`,
        width: `${(region.w / 1280) * 100}%`,
        height: `${(region.h / 800) * 100}%`,
        background: waiting
          ? "radial-gradient(closest-side, rgba(251,191,36,0.16), rgba(251,191,36,0.05) 60%, transparent)"
          : "radial-gradient(closest-side, rgba(165,180,252,0.16), rgba(99,102,241,0.06) 60%, transparent)",
        boxShadow: waiting
          ? "inset 0 0 0 1px rgba(251,191,36,0.18)"
          : "inset 0 0 0 1px rgba(165,180,252,0.18)",
        filter: "blur(2px)",
        animation: "sa-presence-breathe 3.2s ease-in-out infinite",
      }}
    />
  );
}

/** Keepalive spacing for the user-driving pause while the user keeps interacting. */
export const USER_DRIVING_KEEPALIVE_MS = 60_000;

/** True when a pause (first input) or a keepalive (a minute later) should go out. */
export function shouldSendUserDrivingPause(lastSentAt: number, now: number): boolean {
  return lastSentAt === 0 || now - lastSentAt >= USER_DRIVING_KEEPALIVE_MS;
}

export function UserDrivingBanner({ onHandBack }: { onHandBack: () => void }) {
  return (
    <div
      role="status"
      data-testid="user-driving-banner"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-sky-400/35 bg-sky-500/15 px-4 py-2 text-[11px] font-mono text-sky-100"
    >
      <span>You&apos;re driving: A1 is paused</span>
      <button
        type="button"
        data-testid="user-driving-handback"
        onClick={onHandBack}
        className="inline-flex items-center gap-1.5 rounded-lg bg-sky-400 px-2.5 py-1 text-[11px] font-semibold text-zinc-950 transition hover:bg-sky-300"
      >
        Hand back
      </button>
    </div>
  );
}

export function DesktopView({
  vmState,
  vmResetting = false,
  runActive = false,
  runId,
  agentId,
  onStopRun,
  embedded = false,
  control,
  onControlChange,
  onConnection,
  presence,
  computerAction,
  loopNudgeAt,
  canControl = true,
  vmErrorMessage,
}: DesktopViewProps) {
  const [conn, dispatch] = useReducer(reduceDesktopConn, INITIAL_DESKTOP_CONN);
  // Control is negotiated server-side: the user expresses INTENT (Take
  // over), the proxy's takeover machine grants at the agent's safe point.
  // `serverMode` is the last mode the server reported for this client; the
  // effective UI mode is "requested" from intent until the grant lands.
  const [internalIntent, setInternalIntent] = useState(false);
  const controlled = control !== undefined;
  const intentControl = controlled ? Boolean(control) : internalIntent;
  const [serverMode, setServerMode] = useState<DesktopControlMode>("watch");
  const mode: DesktopControlMode = !intentControl
    ? "watch"
    : serverMode === "control"
      ? "control"
      : "requested";
  const [fps, setFps] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number>();
  const [frameSrc, setFrameSrc] = useState<string>();

  // The noVNC surface lives in its own element so its listeners stay scoped
  // away from the rest of the app; the frame box is the visual 16:9 screen.
  const frameRef = useRef<HTMLDivElement>(null);
  const surfaceHolderRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const modeRef = useRef<DesktopControlMode>(mode);
  const intentRef = useRef(intentControl);
  const replayRunRef = useRef(runId);
  const agentRef = useRef(agentId);
  // Stable takeover identity for this mount: the server keys control to it
  // across the reconnect-to-switch dials and the state poll.
  const clientIdRef = useRef("");
  if (!clientIdRef.current) {
    // typeof checks (not `in`) so TS does not narrow crypto to never when
    // randomUUID is absent: the Crypto type declares it required.
    const webCrypto = typeof crypto !== "undefined" ? crypto : undefined;
    if (webCrypto && typeof webCrypto.randomUUID === "function") {
      clientIdRef.current = webCrypto.randomUUID();
    } else if (webCrypto && typeof webCrypto.getRandomValues === "function") {
      const bytes = new Uint8Array(10);
      webCrypto.getRandomValues(bytes);
      clientIdRef.current = `client-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    } else {
      // No WebCrypto at all (ancient engine): a timestamped id is still unique
      // per mount; it is an identity key, not a credential.
      clientIdRef.current = `client-${Date.now().toString(36)}-${(performance.now() * 1000).toString(36)}`;
    }
  }
  // When the current dial opened (RFB connect). Polls older than this
  // describe the previous session and must not read as a denial.
  const dialOpenedAtRef = useRef(0);
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
    const wantsControl = intentRef.current;
    const target = document.createElement("div");
    target.className = "h-full w-full";
    target.style.width = "100%";
    target.style.height = "100%";
    holder.replaceChildren();
    holder.appendChild(target);
    let rfb: RFB;
    try {
      // Intent is the proxy's wire mode: "view" (read-only) or "control"
      // (a takeover request the server grants at the agent's safe point).
      dialStartedRef.current = performance.now();
      rfb = new RFB(
        target,
        desktopWsUrl(wantsControl ? "control" : "view", undefined, clientIdRef.current, runId, agentId),
        { shared: true },
      );
    } catch {
      target.remove();
      dispatch({ type: "refused" });
      return undefined;
    }
    rfbRef.current = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = false;
    // Input stays off until the server grants control (the proxy filters
    // server-side too; this just keeps noVNC from sending into the void).
    rfb.viewOnly = modeRef.current !== "control";
    const rescaleIfVisible = () => {
      if (rfbRef.current !== rfb) return;
      const rect = holder.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        rfb.scaleViewport = true;
      }
    };
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => rescaleIfVisible())
        : null;
    resizeObserver?.observe(holder);
    rfb.addEventListener("connect", () => {
      opened = true;
      dialOpenedAtRef.current = Date.now();
      if (dialStartedRef.current !== undefined) {
        setLatencyMs(Math.max(0, Math.round(performance.now() - dialStartedRef.current)));
      }
      dispatch({ type: "open" });
      rescaleIfVisible();
      if (modeRef.current === "control") rfb.focus({ preventScroll: true });
    });
    rfb.addEventListener("disconnect", (ev) => {
      if (rfbRef.current !== rfb) return; // stale teardown event — ignore
      const clean = Boolean(ev.detail?.clean);
      // RFB already transitioned to "disconnected" before emitting "disconnect";
      // avoid calling rfb.disconnect() again or noVNC logs a disconnected-state error.
      resizeObserver?.disconnect();
      rfbRef.current = null;
      meterRef.current?.stop();
      meterRef.current = null;
      if (surfaceHolderRef.current) {
        surfaceHolderRef.current.replaceChildren();
      }
      dispatch(clean && !opened ? { type: "refused" } : { type: "drop" });
    });
    rfb.addEventListener("credentialsrequired", () => {
      // Auth is injected proxy-side; asking the browser for credentials means
      // the contract is broken — treat as a refused dial.
      resizeObserver?.disconnect();
      if (rfbRef.current === rfb) teardown();
      dispatch({ type: "refused" });
    });
    return () => {
      resizeObserver?.disconnect();
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

  // Keep the effective-mode ref current for the dial loop's viewOnly/focus.
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Intent change (Watch ↔ Take over): different proxy query params, so
  // keep exactly one dial for the new intent. Server-side refinements
  // (requested → control) do NOT re-dial — the grant flips the live
  // socket's filter server-side.
  useEffect(() => {
    if (intentRef.current === intentControl) return;
    intentRef.current = intentControl;
    setServerMode("watch");
    teardown();
    dispatch({ type: "retry-now" });
  }, [intentControl, teardown]);

  // A new run must not keep recording frames onto the previous run's replay:
  // re-dial so the proxy sees the new `run` tag on the session.
  useEffect(() => {
    if (replayRunRef.current === runId) return;
    replayRunRef.current = runId;
    teardown();
    dispatch({ type: "retry-now" });
  }, [runId, teardown]);

  // A different agent means a different desktop: re-dial so the proxy
  // serves the new agent's VM.
  useEffect(() => {
    if (agentRef.current === agentId) return;
    agentRef.current = agentId;
    teardown();
    dispatch({ type: "retry-now" });
  }, [agentId, teardown]);

  // Grant/handback on the live socket: flip noVNC's input gate in step
  // with the effective mode (the proxy enforces the same server-side).
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb || conn.phase !== "live") return;
    rfb.viewOnly = mode !== "control";
    if (mode === "control") rfb.focus({ preventScroll: true });
  }, [mode, conn.phase]);

  // While a takeover is pending (or held), poll the proxy's takeover-state
  // endpoint: the grant (and a denial/expiry) arrives here, not on the RFB
  // stream, which carries no in-band messages.
  useEffect(() => {
    if (!intentControl || conn.phase !== "live") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(desktopTakeoverStateUrl(clientIdRef.current), {
          headers: { Accept: "application/json" },
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as ServerTakeoverState;
        if (cancelled) return;
        setServerMode(controlModeForTakeoverState(data.state, data.isController));
        // Denied or expired server-side (agent driving, not us) on a poll
        // that post-dates this dial: drop the intent back to watch. Polls
        // from before the dial opened describe the previous session.
        if (
          data.state === "AGENT_DRIVING" &&
          !data.isController &&
          Date.now() > dialOpenedAtRef.current + 500
        ) {
          if (controlled) onControlChange?.(false);
          else setInternalIntent(false);
        }
      } catch {
        /* transient; the next tick retries */
      }
    };
    void tick();
    const timer = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intentControl, conn.phase, controlled, onControlChange]);

  // Tell the frame pill what this connection is doing.
  useEffect(() => {
    onConnection?.({ phase: conn.phase, latencyMs, fps, attempt: conn.attempt, takeover: mode });
  }, [onConnection, conn.phase, conn.attempt, latencyMs, fps, mode]);

  const switchMode = useCallback((next: DesktopControlMode) => {
    const wantsControl = next === "control";
    if (wantsControl === intentRef.current) return;
    if (controlled) onControlChange?.(wantsControl);
    else setInternalIntent(wantsControl);
  }, [controlled, onControlChange]);

  const onReconnect = useCallback(() => {
    if (conn.phase === "offline") {
      void fetch("/api/runtime/vm/status", { method: "POST" }).catch(() => undefined);
    }
    teardown();
    dispatch({ type: "retry-now" });
  }, [conn.phase, teardown]);

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
  const [userDrivingPaused, setUserDrivingPaused] = useState(false);
  /** When the last pause/keepalive went out (0 = none this takeover). */
  const pauseSentRef = useRef(0);

  useEffect(() => {
    if (!runActive || mode !== "control") {
      setUserDrivingPaused(false);
      pauseSentRef.current = 0;
    }
  }, [runActive, mode]);

  const notifyUserInput = useCallback(() => {
    if (mode !== "control" || !runActive || !runId) return;
    // First input pauses A1; continued input re-sends at most once a minute
    // so a long takeover never hits the server's 5-minute idle expiry.
    if (!shouldSendUserDrivingPause(pauseSentRef.current, Date.now())) return;
    pauseSentRef.current = Date.now();
    setUserDrivingPaused(true);
    void fetch(`/api/runtime/runs/${encodeURIComponent(runId)}/pause-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    }).catch(() => {});
  }, [mode, runActive, runId]);

  const handbackUserInput = useCallback(() => {
    pauseSentRef.current = 0;
    setUserDrivingPaused(false);
    if (runId) {
      void fetch(`/api/runtime/runs/${encodeURIComponent(runId)}/pause-input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "handback" }),
      }).catch(() => {});
    }
    switchMode("watch");
  }, [runId, switchMode]);

  // Embedded: fill the ScreenFrame's 16:10 stage with just the surface and
  // the connection-state overlays. The frame owns the pill, mode control,
  // fullscreen and control banner.
  if (embedded) {
    return (
      <div
        className="relative h-full w-full bg-black"
        data-testid="desktop-view"
        onPointerDown={notifyUserInput}
        onKeyDown={notifyUserInput}
      >
        {userDrivingPaused && (
          <div className="absolute inset-x-0 top-0 z-20">
            <UserDrivingBanner onHandBack={handbackUserInput} />
          </div>
        )}
        <div ref={surfaceHolderRef} className="absolute inset-0 transform-gpu" aria-hidden={!live} />

        {/* Presence: the agent is working here. A blurred tint over the
            region, fading with the run — it never covers the pixels it is
            pointing at, and pointer events pass through it. */}
        <PresenceGlow presence={presence} />

        {/* Computer-use action: click ripple / cursor reticle + HUD chip at
            the action's coordinates. Pointer-events-none throughout. */}
        <ComputerActionOverlay action={computerAction} loopNudgeAt={loopNudgeAt} />

        {/* Watch mode, always visible in control: the one way out. While the
            takeover is only requested, the same button cancels the request. */}
        {control && (
          <button
            type="button"
            onClick={() => onControlChange?.(false)}
            className="absolute right-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-full border border-sa-accent/50 bg-sa-accent/20 px-2.5 py-1 font-mono text-[10px] text-white backdrop-blur transition-colors hover:bg-sa-accent/30"
            data-testid="desktop-hand-back"
          >
            <Hand className="h-3 w-3" aria-hidden /> {mode === "requested" ? "Cancel" : "Hand back"}
          </button>
        )}

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
          <DesktopBootingOverlay vmState={vmState} phase={conn.phase} errorMessage={vmErrorMessage} />
        )}

        {conn.phase === "reconnecting" && (
          <DesktopOverlayCard>
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
          </DesktopOverlayCard>
        )}

        {conn.phase === "offline" && (
          <DesktopOverlayCard>
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
          </DesktopOverlayCard>
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

      {/* Takeover-requested banner: the agent still has the wheel. */}
      {mode === "requested" && live && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-400/35 bg-amber-500/15 px-4 py-2 text-[11px] font-mono text-amber-200" data-testid="desktop-requested-banner">
          <span className="font-semibold uppercase tracking-wide">Takeover requested</span>
          <span className="text-amber-100/80">
            Waiting for the agent to reach a safe point — input still goes to the agent.
          </span>
        </div>
      )}

      {userDrivingPaused && <UserDrivingBanner onHandBack={handbackUserInput} />}

      {/* 16:9 screen frame with the glass corner radius */}
      <div className="flex flex-1 items-start justify-center p-3 min-h-0">
        <div
          ref={frameRef}
          onPointerDown={notifyUserInput}
          onKeyDown={notifyUserInput}
          className="relative w-full max-w-[960px] overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_10px_40px_rgba(0,0,0,0.6)]"
          style={{ aspectRatio: "16 / 9" }}
        >
          {/* noVNC surface (live) */}
          <div ref={surfaceHolderRef} className="absolute inset-0 transform-gpu" aria-hidden={!live} />

          {/* Computer-use action overlay: ripple / reticle + HUD chip. */}
          <ComputerActionOverlay action={computerAction} loopNudgeAt={loopNudgeAt} />

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
            <DesktopBootingOverlay vmState={vmState} phase={conn.phase} errorMessage={vmErrorMessage} />
          )}
          {conn.phase === "reconnecting" && (
            <DesktopOverlayCard>
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
            </DesktopOverlayCard>
          )}
          {conn.phase === "offline" && !conn.hasFrame && (
            <DesktopOverlayCard>
              <span className="text-xs font-mono text-white/50">
                Desktop offline{mode === "control" ? "" : " · watch-only preview unavailable"}
              </span>
              <span className="text-[11px] font-mono text-white/30">
                Running with desktop mode off? The terminal, browser and files tabs are unaffected.
              </span>
            </DesktopOverlayCard>
          )}

          {/* LIVE badge: red dot + fps while streaming */}
          {live && (
            <div className={cn(GLASS.liveBadge, "pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1.5 px-2 py-0.5 font-mono text-[10px] text-white/85")}>
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
        ) : mode === "requested" ? (
          <>
            <span
              aria-live="polite"
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/35 bg-amber-500/15 px-2.5 py-1 text-[11px] font-mono text-amber-200"
              data-testid="desktop-mode-requested"
            >
              <RefreshCw className="h-3 w-3 shrink-0 animate-spin" />
              <span className="hidden sm:inline">Waiting for safe point…</span>
            </span>
            <button
              type="button"
              onClick={() => switchMode("watch")}
              title="Cancel the takeover request"
              aria-label="Cancel takeover request"
              data-testid="desktop-cancel-takeover-button"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] font-mono text-white/85 transition hover:bg-white/20"
            >
              <Hand className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline">Cancel</span>
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
