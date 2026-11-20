"use client";

/**
 * ScreenFrame — the agent's computer: one toolbar, then the largest stage that
 * fits.
 *
 * The noVNC viewer stays in DesktopView and the tool views in ComputerScreen;
 * this component owns the chrome around them:
 *
 *   - a toolbar above the screen (never on top of it): the view tabs, the
 *     connection status, Take over, and full screen;
 *   - the live desktop as a real 1280×800 screen scaled to the largest 16:10
 *     rectangle that fits, measured with a ResizeObserver;
 *   - the tool views (terminal, browser, files) filling the box natively so
 *     their text stays readable;
 *   - take-over mode: an accent frame and a status line. There is no
 *     pause-run API, so the line says the agent keeps working. Esc always
 *     hands control back.
 *
 * Full screen covers the page header, so the toolbar shows Stop there: a run
 * can always be stopped from wherever the user is.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileText, Globe, Hand, Maximize2, Minimize2, MonitorPlay, MousePointerClick, Square, Terminal } from "lucide-react";
import type { LogEvent } from "../../engine";
import type { DesktopPhase } from "../../../../lib/client/desktopState";
import type { StatusTone } from "../../../../lib/client/runPhase";
import type { VmDisplayState } from "../../../../lib/client/vmStatus";
import type { VmStatus } from "../../../../lib/vm/types";
import { cn } from "../../utils/cn";
import { ComputerScreen, type ComputerView } from "../ComputerScreen";
import { DesktopView, type DesktopConnectionInfo } from "../DesktopView";
import { Button, IconButton, Segmented, StatusBadge, type SegmentOption } from "../ui";

export interface ScreenFrameProps {
  activeView: ComputerView;
  onToggleView: (view: ComputerView) => void;
  showDesktop: boolean;
  logs: LogEvent[];
  runId?: string;
  runActive: boolean;
  vmState: VmDisplayState;
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
   * Fill the available box (width AND height), keeping the stage as large as
   * fits, instead of sizing by width alone.
   */
  fitToHeight?: boolean;
  className?: string;
}

const VIEW_TABS: SegmentOption<ComputerView>[] = [
  { id: "desktop", label: "Desktop", icon: <MonitorPlay className="h-3.5 w-3.5" aria-hidden /> },
  { id: "terminal", label: "Terminal", icon: <Terminal className="h-3.5 w-3.5" aria-hidden /> },
  { id: "browser", label: "Browser", icon: <Globe className="h-3.5 w-3.5" aria-hidden /> },
  { id: "files", label: "Files", icon: <FileText className="h-3.5 w-3.5" aria-hidden /> },
];

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
  phase?: DesktopPhase;
  latencyMs?: number;
}): ScreenStatus {
  if (input.control) return { label: "You are in control", tone: "accent", live: false };
  if (input.activeView === "desktop") {
    const phase: DesktopPhase = input.phase ?? "connecting";
    if (phase === "live") {
      const latency = input.latencyMs !== undefined ? ` · ${input.latencyMs} ms` : "";
      return { label: `Live${latency}`, tone: "ok", live: true };
    }
    if (phase === "starting") return { label: "Starting", tone: "warn", live: true };
    if (phase === "connecting") return { label: "Connecting", tone: "warn", live: true };
    if (phase === "reconnecting") return { label: "Reconnecting", tone: "warn", live: true };
    return { label: "Offline", tone: "err", live: false };
  }
  if (input.runActive) return { label: "Live", tone: "ok", live: true };
  return { label: "Idle", tone: "muted", live: false };
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
  vmState,
  vmResetting,
  polledVmStatus,
  desktopMode,
  activeRoleName,
  onResetVm,
  onStopRun,
  onShellRunStarted,
  control,
  onControlChange,
  canControl,
  fitToHeight,
  className,
}: ScreenFrameProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState({ width: 0, height: 0 });
  const [theater, setTheater] = useState(false);
  const [conn, setConn] = useState<DesktopConnectionInfo>();

  // Fit by both dimensions when the layout gives the frame a height (wide
  // screens, full screen); otherwise the stage is 16:10 of the column width.
  const fitMode = Boolean(fitToHeight) || theater;

  // The desktop is a 1280×800 screen scaled to the stage's width.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / 1280);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!fitMode) return;
    const el = fitRef.current;
    if (!el) return;
    const update = () => setFit({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitMode]);

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
  const status = screenStatus({ activeView, runActive, control, phase: conn?.phase, latencyMs: conn?.latencyMs });
  const tabs = showDesktop ? VIEW_TABS : VIEW_TABS.filter((tab) => tab.id !== "desktop");
  const fitScale = fitMode ? fitStageScale(fit) : null;

  let stageStyle: React.CSSProperties | undefined;
  if (fitMode) {
    if (!showStageDesktop) stageStyle = { width: "100%", height: "100%" };
    else if (fitScale !== null) stageStyle = { width: Math.floor(1280 * fitScale), height: Math.floor(800 * fitScale) };
    else stageStyle = { width: "100%", aspectRatio: "16 / 10" };
  }

  return (
    <div
      className={
        // Above the sheets (z-50), below toasts (z-60) and the approval prompt (z-90).
        theater ? "fixed inset-0 z-[55] flex flex-col gap-2 bg-sa-bg p-2 sm:p-3" : cn("flex min-h-0 flex-col gap-2", className)
      }
      data-testid="screen-frame"
      data-control={control ? "true" : "false"}
      data-fullscreen={theater ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="screen-toolbar">
        <Segmented
          label="Computer views"
          options={tabs}
          value={activeView}
          onChange={onToggleView}
          testIdPrefix="screen-view"
        />
        <StatusBadge tone={status.tone} label={status.label} live={status.live} testId="screen-status-pill" />
        <span className="ml-auto flex items-center gap-1.5">
          {theater && runActive && (
            <Button variant="danger" size="sm" onClick={onStopRun} data-testid="screen-stop-run">
              <Square className="h-3 w-3 fill-current" aria-hidden />
              Stop
            </Button>
          )}
          {showStageDesktop && (
            <Button
              size="sm"
              variant={control ? "primary" : "secondary"}
              aria-pressed={control}
              disabled={!control && !canControl}
              title={
                control
                  ? "Give the desktop back to the agent (Esc)"
                  : canControl
                    ? "Use the desktop yourself"
                    : "The desktop is not ready yet"
              }
              onClick={() => onControlChange(!control)}
              data-testid="take-over"
            >
              <MousePointerClick className="h-3.5 w-3.5" aria-hidden />
              {control ? "Hand back" : "Take over"}
            </Button>
          )}
          <IconButton label={theater ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen} data-testid="screen-fullscreen">
            {theater ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
          </IconButton>
        </span>
      </div>

      {control && (
        <div
          role="status"
          data-testid="takeover-banner"
          className="flex items-center gap-2 rounded-lg bg-sa-accent px-3 py-2 text-[13px] font-medium text-white"
        >
          <Hand className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            You are in control.{" "}
            <span className="font-normal text-white/85">
              {runActive ? "The agent is still working. Press Esc to hand back." : "Press Esc to hand back."}
            </span>
          </span>
        </div>
      )}

      <div ref={fitRef} className={fitMode ? "flex min-h-0 w-full flex-1 items-center justify-center" : "w-full"}>
        <div
          ref={hostRef}
          data-testid="screen-stage"
          style={stageStyle}
          className={cn(
            "relative overflow-hidden border bg-black",
            !fitMode && "aspect-[16/10] w-full",
            theater ? "rounded-lg" : "rounded-xl",
            control ? "border-sa-accent shadow-[0_0_0_1px_var(--color-sa-accent)]" : "border-sa-line",
          )}
        >
          {showStageDesktop ? (
            /* The live desktop is a real 1280×800 screen scaled to the frame. */
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: 1280, height: 800 }}
            >
              <DesktopView
                vmState={vmState}
                vmResetting={vmResetting}
                runActive={runActive}
                onStopRun={onStopRun}
                embedded
                control={control}
                onControlChange={onControlChange}
                onConnection={onConn}
              />
            </div>
          ) : (
            /* Tool views are UI, not a video stream: they fill the frame
               natively so terminal text stays readable on phones. */
            <div className="absolute inset-0 overflow-hidden">
              <ComputerScreen
                logs={logs}
                runId={runId}
                activeView={activeView === "desktop" ? "terminal" : activeView}
                onToggleView={onToggleView}
                onResetVm={onResetVm}
                vmResetting={vmResetting}
                activeRoleName={activeRoleName}
                onShellRunStarted={onShellRunStarted}
                polledVmStatus={polledVmStatus}
                desktopMode={false}
                embedded
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ScreenFrame;
