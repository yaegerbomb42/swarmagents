"use client";

/**
 * ScreenFrame — the computer's stage in the workspace: one frame, one set of
 * chrome, the largest screen that fits.
 *
 * The chrome itself (view switcher, presence, status bar) lives in
 * `../vm/VmChrome` and is rendered exactly once by `VmScreen`. This component
 * only decides how big the frame is and supplies the workspace-level controls
 * that sit in the shared top bar:
 *
 *   - the stage fills the box the layout gives it (or takes the column width
 *     at 16:10), and the live desktop inside it is left to noVNC's own
 *     scaling, so nothing re-scales — and nothing re-mounts — on a tab switch;
 *   - take-over: an accent ring around the stage, a banner above it; Esc
 *     always hands control back;
 *   - full screen (theater) covering the page header, with Stop kept in reach.
 *
 * There is no second toolbar here any more: that extra chrome was what made
 * the four VM views feel like four separate widgets.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Hand, Maximize2, Minimize2, Square } from "lucide-react";
import type { LogEvent } from "../../engine";
import type { DesktopConnectionInfo } from "../DesktopView";
import type { DesktopControlMode } from "../../../../lib/client/desktopState";
import type { StatusTone } from "../../../../lib/client/runPhase";
import type { VmStatus } from "../../../../lib/vm/types";
import { cn } from "../../utils/cn";
import { GLASS } from "../../design/vm-tokens";
import { Button, IconButton } from "../ui";
import { StatusPill, TakeoverButton, type PillStatus } from "../brand";
import { VmScreen, type ComputerView } from "../vm/VmScreen";
import type { ComputerAction, Presence } from "../../../../lib/client/presence";

export interface ScreenFrameProps {
  activeView: ComputerView;
  onToggleView: (view: ComputerView) => void;
  showDesktop: boolean;
  logs: LogEvent[];
  runId?: string;
  runActive: boolean;
  /** VM display state (kept for callers that already computed it). */
  vmState?: string;
  vmResetting: boolean;
  polledVmStatus?: VmStatus;
  desktopMode: boolean;
  activeRoleName: string;
  onResetVm: () => void;
  onStopRun: () => void;
  onShellRunStarted?: (runId: string) => void;
  /** True while the user is driving the VM. Controlled by App. */
  control: boolean;
  onControlChange: (control: boolean) => void;
  /** False while the VM is not ready (or desktop mode is off). */
  canControl: boolean;
  /**
   * Fill the available box (width AND height) instead of taking the column
   * width at 16:10.
   */
  fitToHeight?: boolean;
  className?: string;
  /** Open this workspace file in the Files view (Codebase drawer). */
  filesOpenPath?: string;
  /**
   * The newest activity line(s) from the page's poll. The main page's
   * conversation already consumes the run's SSE stream, so the screen's own
   * useRunStream sees nothing; presence falls back to these lines.
   */
  activity?: ReadonlyArray<{ text: string }>;
  /** The page's already-derived presence (it owns the run's stream). */
  presence?: Presence;
  /** The page's already-derived latest computer-use action. */
  computerAction?: ComputerAction;
  /** The page's already-derived newest watchdog.loop nudge (epoch ms). */
  loopNudgeAt?: number;
}

export interface ScreenStatus {
  label: string;
  tone: StatusTone;
  /** Pulse the dot: something is in motion. */
  live: boolean;
}

/** What the screen is doing, in the same dot-and-word vocabulary as a run's status. */
export function screenStatus(input: {
  activeView: ComputerView;
  runActive: boolean;
  control: boolean;
  phase?: string;
  latencyMs?: number;
  /** Effective takeover mode reported by DesktopView (requested ≠ control). */
  takeover?: DesktopControlMode;
}): ScreenStatus {
  if (input.takeover === "requested") {
    return { label: "Waiting for safe point", tone: "warn", live: true };
  }
  if (input.control) return { label: "You are in control", tone: "accent", live: false };
  if (input.activeView === "desktop") {
    const phase = input.phase ?? "connecting";
    if (phase === "live") {
      const latency = input.latencyMs !== undefined ? ` · ${input.latencyMs} ms` : "";
      // A live stream with a working run is "Running" — the agent is
      // driving. A live stream with no run is just "Live": the desktop is
      // up and waiting. The pill's three core states are idle / running /
      // reconnecting; "Live" names the stream, not the run.
      return { label: `${input.runActive ? "Running" : "Live"}${latency}`, tone: "ok", live: true };
    }
    if (phase === "starting") return { label: "Starting", tone: "warn", live: true };
    if (phase === "connecting") return { label: "Connecting", tone: "warn", live: true };
    if (phase === "reconnecting") return { label: "Reconnecting", tone: "warn", live: true };
    return { label: "Offline", tone: "err", live: false };
  }
  if (input.runActive) return { label: "Running", tone: "ok", live: true };
  return { label: "Idle", tone: "muted", live: false };
}

/** The brand pill tone for a screen status: accent is the Signal `running` tone. */
export function screenPillStatus(status: ScreenStatus): PillStatus {
  switch (status.tone) {
    case "accent":
      return "running";
    case "ok":
      return "ok";
    case "warn":
      return "warn";
    case "err":
      return "error";
    case "muted":
      return "idle";
  }
}

/** The largest 16:10 rectangle inside a box, as a scale of 1280×800. */
export function fitStageScale(box: { width: number; height: number }): number | null {
  if (box.width <= 0 || box.height <= 0) return null;
  return Math.min(box.width / 1280, box.height / 800);
}

export function ScreenFrame({
  activeView,
  onToggleView,
  showDesktop,
  logs,
  runId,
  runActive,
  vmState: _vmState,
  vmResetting,
  polledVmStatus,
  desktopMode,
  activeRoleName,
  onResetVm: _onResetVm,
  onStopRun,
  onShellRunStarted,
  control,
  onControlChange,
  canControl,
  fitToHeight,
  className,
  filesOpenPath,
  activity,
  presence,
  computerAction,
  loopNudgeAt,
}: ScreenFrameProps) {
  const [theater, setTheater] = useState(false);
  const [conn, setConn] = useState<DesktopConnectionInfo>();

  // The browser's own Esc leaves native full screen; follow it.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setTheater(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const exitTheater = useCallback(() => {
    setTheater(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);

  // Esc closes full screen first, then hands control back. It never stops a run.
  useEffect(() => {
    if (!theater && !control) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (theater) exitTheater();
      else onControlChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [control, theater, onControlChange, exitTheater]);

  const toggleFullscreen = useCallback(() => {
    if (theater) {
      exitTheater();
      return;
    }
    setTheater(true);
    // The whole page goes full screen (not just this frame) so the approval
    // prompt and toasts, which live outside it, still show on top.
    const request = document.documentElement.requestFullscreen?.();
    if (request) void request.catch(() => undefined);
  }, [theater, exitTheater]);

  const onConn = useCallback((info: DesktopConnectionInfo) => setConn(info), []);
  const showStageDesktop = activeView === "desktop" && desktopMode;
  const status = screenStatus({ activeView, runActive, control, phase: conn?.phase, latencyMs: conn?.latencyMs, takeover: conn?.takeover });

  // The workspace controls that live in the shared top bar. The status pill
  // and the take-over control are the brand components (spec 3g): one
  // dot-and-word vocabulary, one driver slot, in the chrome of the frame.
  const frameControls = (
    <>
      {/* The one live-status light, in the same vocabulary as a run's. The
          full status bar sits under the stage; this is the at-a-glance copy. */}
      <StatusPill status={screenPillStatus(status)} live={status.live} testId="screen-status-pill">
        {status.label}
      </StatusPill>
      {showStageDesktop && (
        <TakeoverButton
          driver={control ? "human" : "agent"}
          onTakeover={() => onControlChange(true)}
          onHandback={() => onControlChange(false)}
          disabled={!control && !canControl}
          disabledReason="The desktop is not ready yet"
          testId="take-over"
        />
      )}
      {theater && runActive && (
        <Button variant="danger" size="sm" onClick={onStopRun} data-testid="screen-stop-run">
          <Square className="h-3 w-3 fill-current" aria-hidden />
          Stop
        </Button>
      )}
      <IconButton
        label={theater ? "Exit full screen" : "Full screen"}
        onClick={toggleFullscreen}
        data-testid="screen-fullscreen"
      >
        {theater ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
      </IconButton>
    </>
  );

  return (
    <div
      className={
        // Above the sheets (z-50), below toasts (z-60) and the approval prompt (z-90).
        theater ? "fixed inset-0 z-[55] flex flex-col gap-2 bg-sa-bg p-2 sm:p-3" : cn("flex min-h-0 flex-col", className)
      }
      data-testid="screen-frame"
      data-control={control ? "true" : "false"}
      data-fullscreen={theater ? "true" : "false"}
      data-view={activeView}
    >
      {conn?.takeover === "requested" ? (
        <div
          role="status"
          data-testid="takeover-requested-banner"
          className="mb-1 flex shrink-0 items-center gap-2 rounded-lg border border-sa-warn/40 bg-sa-warn/15 px-3 py-2 text-[13px] font-medium text-sa-warn"
        >
          <Hand className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            Takeover requested.{" "}
            <span className="font-normal text-sa-fg2">
              Waiting for the agent to reach a safe point — input still goes to the agent. Press Esc to cancel.
            </span>
          </span>
        </div>
      ) : control ? (
        <div
          role="status"
          data-testid="takeover-banner"
          className="mb-1 flex shrink-0 items-center gap-2 rounded-lg border border-sa-accent/40 bg-sa-accent/15 px-3 py-2 text-[13px] font-medium text-sa-accent-fg"
        >
          <Hand className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            You are in control.{" "}
            <span className="font-normal text-sa-fg2">
              {runActive ? "The agent is still working. Press Esc to hand back." : "Press Esc to hand back."}
            </span>
          </span>
        </div>
      ) : null}

      {/*
        One VmScreen for the whole session. Its four stages are mounted on
        first visit and then only hidden, so switching tabs never unmounts the
        noVNC surface (no reconnect, no first-frame repaint) or replays the
        terminal. `fitToHeight` is the one sizing switch: fill the box, or
        take the column width at the screen's own 16:10.
      */}
      <div
        className={cn(
          "flex min-h-0 w-full flex-1 overflow-hidden rounded-xl border bg-black",
          GLASS.frame,
          control ? "border-sa-accent shadow-[0_0_0_1px_var(--color-sa-accent)]" : "border-sa-line",
          !fitToHeight && !theater && "aspect-[16/10] flex-none",
        )}
        data-testid="screen-stage"
      >
        <VmScreen
          logs={logs}
          runId={runId}
          activeView={activeView}
          onToggleView={onToggleView}
          onResetVm={() => undefined}
          vmResetting={vmResetting}
          activeRoleName={activeRoleName}
          onShellRunStarted={onShellRunStarted}
          onStopRun={onStopRun}
          polledVmStatus={polledVmStatus}
          desktopMode={showDesktop && desktopMode}
          filesOpenPath={filesOpenPath}
          control={control}
          onControlChange={onControlChange}
          canControl={canControl}
          onConnection={onConn}
          controls={frameControls}
          activity={activity}
          presence={presence}
          computerAction={computerAction}
          loopNudgeAt={loopNudgeAt}
          className="h-full rounded-none border-0"
        />
      </div>
    </div>
  );
}

export default ScreenFrame;
