"use client";

/**
 * VmChrome — the one chrome and the one status bar every VM view shares.
 *
 * Before this, each view drew its own furniture: ComputerScreen had a Mac-dot
 * titlebar, ScreenFrame had a toolbar above the stage, BrowserView had a
 * browser-styled address bar, FilesView had a breadcrumb strip. Switching tabs
 * changed the language under the user. Now:
 *
 *   ┌ VmChrome ───────────────────────────────────────────────┐
 *   │ [desktop|terminal|browser|files]   presence    controls │  ← one bar
 *   ├─────────────────────────────────────────────────────────┤
 *   │                     VmStage (the view)                  │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ ● Computer ready  ● Working Editing x.py  ● Live 12 ms  │  ← one status bar
 *   └─────────────────────────────────────────────────────────┘
 *
 * Both bars are the same graphite (design/vm-tokens.ts), the same height, the
 * same hairline. Views pass their own toolbar content into the stage as a
 * `tools` slot so a view-specific control (Refresh, address bar) still lives
 * *inside* the shared frame rather than inventing new chrome above it.
 *
 * The desktop tab additionally fades the whole chrome away when the user is
 * just watching: `idle` prop, driven by useIdleChrome in the frame. Hover or
 * keyboard focus brings it straight back, and it never fades while the user
 * is driving the desktop.
 */

import React, { useState } from "react";
import { FileText, Globe, Loader2, MonitorPlay, Terminal } from "lucide-react";
import type { RunStreamStatus } from "../../../../lib/client/useRunStream";
import type { StatusTone } from "../../../../lib/client/runPhase";
import type { VmDisplay } from "../../../../lib/client/vmStatus";
import { presenceLabel, presenceTone, type Presence } from "../../../../lib/client/presence";
import { CHROME, GLASS, MOTION, SURFACE, TONE, pluralize, shortPath } from "../../design/vm-tokens";
import { cn } from "../../utils/cn";

export type ComputerView = "desktop" | "terminal" | "browser" | "files";

export interface ViewTab {
  view: ComputerView;
  label: string;
  Icon: typeof Terminal;
}

export const VM_VIEW_TABS: readonly ViewTab[] = [
  { view: "desktop", label: "Desktop", Icon: MonitorPlay },
  { view: "terminal", label: "Terminal", Icon: Terminal },
  { view: "browser", label: "Browser", Icon: Globe },
  { view: "files", label: "Files", Icon: FileText },
];

/* ── The view switcher ───────────────────────────────────────────────────── */

/**
 * One pill group, roving arrow-key focus, identical in all four views. The
 * active tab is a raised chip — the same chip whether the view behind it is a
 * live desktop or a file tree.
 */
export function ViewTabs({
  tabs,
  value,
  onChange,
  className,
  compact = false,
}: {
  tabs: readonly ViewTab[];
  value: ComputerView;
  onChange: (view: ComputerView) => void;
  className?: string;
  /**
   * Names only the active tab; the others are icons with their name in the
   * tooltip. Keeps the bar to one line on phones and in the split view.
   */
  compact?: boolean;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.view === value);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange(tabs[next].view);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Computer views"
      onKeyDown={onKeyDown}
      className={cn(CHROME.tabGroup, className)}
    >
      {tabs.map(({ view, label, Icon }, index) => {
        const active = view === value;
        return (
          <button
            key={view}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-testid={`screen-view-${view}`}
            onClick={() => onChange(view)}
            aria-label={label}
            title={label}
            className={cn(CHROME.tab, active ? CHROME.tabActive : CHROME.tabIdle, compact && !active && "px-1.5")}
          >
            <Icon className="h-3 w-3" aria-hidden />
            <span className={compact && !active ? "sr-only" : undefined}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Presence ────────────────────────────────────────────────────────────── */

/**
 * The presence chip: a pulsing dot, the run state, and the agent's current
 * action. Long actions truncate; the full text is in the tooltip, and the
 * file is repeated in the status bar where it has more room.
 */
export function PresenceChip({ presence, className }: { presence: Presence; className?: string }) {
  const tone = presenceTone(presence);
  const working = presence.runState === "working";
  const label = presenceLabel(presence);
  const detail = presence.action && presence.action !== label ? presence.action : undefined;
  return (
    <span
      data-testid="vm-presence"
      data-run-state={presence.runState}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
        TONE[tone].pill,
        className,
      )}
      title={detail ? `${label} · ${detail}` : label}
    >
      {working ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
      ) : (
        <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE[tone].dot, tone !== "muted" && "sa-dot-live")} />
      )}
      <span className="shrink-0 font-medium">{label}</span>
      {detail && (
        <span className="hidden min-w-0 truncate font-mono text-[10px] opacity-80 md:inline">{detail}</span>
      )}
    </span>
  );
}

/* ── Status bar ──────────────────────────────────────────────────────────── */

export interface StatusBarProps {
  vm: VmDisplay;
  vmResetting?: boolean;
  presence: Presence;
  /** Run stream connection health, or null when no run is attached. */
  stream: { status: RunStreamStatus; reconnecting: boolean } | null;
  /** The live desktop's measured latency, when the desktop is on stage. */
  latencyMs?: number;
  /** Extra item(s) appended before the right-aligned end (view-specific). */
  extra?: React.ReactNode;
  /** Tool calls / files touched — the run's footprint, shown when known. */
  stats?: { toolCalls: number; filesTouched: number };
  /** Path the view is showing (folder for Files, URL for Browser). */
  location?: string;
  /** Rendered at the far right (e.g. a flash badge). */
  end?: React.ReactNode;
  testId?: string;
}

const VM_TONE: Record<string, StatusTone> = {
  starting: "warn",
  ready: "ok",
  hibernated: "muted",
  error: "err",
};

const STREAM_META: Record<RunStreamStatus, { label: string; tone: StatusTone }> = {
  idle: { label: "no run", tone: "muted" },
  connecting: { label: "connecting", tone: "warn" },
  connected: { label: "live", tone: "ok" },
  reconnecting: { label: "reconnecting", tone: "warn" },
};

/** One status light + word. The whole bar is built from these. */
function StatusItem({
  tone,
  label,
  detail,
  live,
  title,
  testId,
  className,
}: {
  tone: StatusTone;
  label: string;
  detail?: string;
  live?: boolean;
  title?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      title={title}
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE[tone].dot, live && "sa-dot-live")} />
      <span className={cn("shrink-0", TONE[tone].text)}>{label}</span>
      {detail && <span className="min-w-0 truncate font-mono text-[10px] text-sa-fg3">{detail}</span>}
    </span>
  );
}

/**
 * The one status bar: VM state, run state (with the current action), stream
 * health, and the view's location. Same three facts in every view, in the
 * same order, so the user reads it once and knows where to look forever.
 */
export function VmStatusBar({
  vm,
  vmResetting = false,
  presence,
  stream,
  latencyMs,
  extra,
  stats,
  location,
  end,
  testId = "vm-statusbar",
}: StatusBarProps) {
  const vmTone = vmResetting ? "warn" : VM_TONE[vm.state] ?? "muted";
  const vmLabel = vmResetting ? "Resetting" : vm.label;
  const streamMeta = stream ? STREAM_META[stream.status] : null;
  const streamLabel =
    stream?.reconnecting && stream.status !== "reconnecting" ? "reconnecting" : streamMeta?.label ?? "";
  const streamTone: StatusTone =
    stream?.reconnecting && stream.status !== "reconnecting" ? "warn" : streamMeta?.tone ?? "muted";
  const runTone = presenceTone(presence);
  const action =
    presence.runState === "idle"
      ? "waiting for a task"
      : presence.runState === "done" && !presence.action
        ? "last run finished"
        : presence.action;

  return (
    <div
      data-testid={testId}
      role="status"
      aria-live="polite"
      className={cn(CHROME.statusBar, CHROME.statusBarLook, "text-sa-fg2")}
    >
      <StatusItem
        tone={vmTone as StatusTone}
        label={`Computer ${vmLabel.toLowerCase()}`}
        title={vm.tooltip}
        live={vmTone === "warn"}
        testId="vm-status-computer"
      />
      <span aria-hidden className="h-3 w-px shrink-0 bg-sa-line" />
      <StatusItem
        tone={runTone}
        label={presenceLabel(presence).toLowerCase()}
        detail={action && action !== presenceLabel(presence).toLowerCase() ? action : undefined}
        live={presence.runState === "working" || presence.runState === "waiting"}
        title={action}
        testId="vm-status-run"
        className="min-w-0 flex-1"
      />
      {presence.wroteFile && (
        <StatusItem
          tone="ok"
          label="changed"
          detail={shortPath(presence.wroteFile)}
          title={presence.wroteFile}
          testId="vm-status-changed"
          className="hidden lg:inline-flex"
        />
      )}
      {stats && stats.toolCalls > 0 && (
        <span
          data-testid="vm-status-stats"
          className="hidden shrink-0 font-mono text-[10px] text-sa-fg3 xl:inline"
          title={`${pluralize(stats.toolCalls, "tool call")} · ${pluralize(stats.filesTouched, "file")} touched`}
        >
          {stats.toolCalls} calls{stats.filesTouched > 0 ? ` · ${stats.filesTouched} files` : ""}
        </span>
      )}
      {extra}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {location && (
          <span className="hidden max-w-[220px] truncate font-mono text-[10px] text-sa-fg3 md:inline" title={location}>
            {location}
          </span>
        )}
        {streamMeta && (
          <StatusItem
            tone={streamTone}
            label={streamLabel}
            detail={latencyMs !== undefined ? `${latencyMs} ms` : undefined}
            live={streamTone === "warn" || streamTone === "ok"}
            title={
              streamTone === "ok"
                ? `Run stream connected${latencyMs !== undefined ? ` · ${latencyMs} ms` : ""}`
                : `Run stream: ${streamLabel}`
            }
            testId="vm-status-stream"
          />
        )}
        {end}
      </span>
    </div>
  );
}

/* ── The frame ───────────────────────────────────────────────────────────── */

export interface VmFrameProps {
  tabs: readonly ViewTab[];
  activeView: ComputerView;
  onToggleView: (view: ComputerView) => void;
  /** Presence chip on the left of the controls. Omit on very narrow stages. */
  presence?: Presence;
  /** Right-aligned controls in the top bar (Take over, full screen, …). */
  controls?: React.ReactNode;
  /** View-specific controls inside the top bar, after the tabs. */
  toolbar?: React.ReactNode;
  /**
   * Fade the top bar and status bar away (the desktop's watch mode). Pointer
   * movement or keyboard focus restores them; the bars stay in the layout so
   * the stage never jumps.
   */
  chromeIdle?: boolean;
  statusBar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  /** The frame element, so the idle detector can see whether the pointer rests on it. */
  frameRef?: React.RefObject<HTMLDivElement | null>;
  /** Icon-only inactive tabs (phones, narrow split columns). */
  compactTabs?: boolean;
}

/**
 * The shell every view renders inside. The bars are always present and always
 * the same height; only their opacity changes when the desktop steps back, so
 * the noVNC surface is never re-mounted (and never re-scaled) by a fade.
 */
export function VmFrame({
  tabs,
  activeView,
  onToggleView,
  presence,
  controls,
  toolbar,
  chromeIdle = false,
  statusBar,
  children,
  className,
  testId = "vm-frame",
  frameRef,
  compactTabs = false,
}: VmFrameProps) {
  // Hovering a faded bar brings it back immediately, before the pointer moves.
  const [hovered, setHovered] = useState(false);
  const shown = !chromeIdle || hovered;
  return (
    <div
      ref={frameRef}
      className={cn(
        "flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-sa-line",
        SURFACE.stage,
        GLASS.frame,
        className,
      )}
      data-testid={testId}
      data-chrome={chromeIdle ? "idle" : "shown"}
    >
      <div
        data-testid="screen-toolbar"
        className={cn(
          CHROME.bar,
          CHROME.barLook,
          MOTION.chromeFade,
          shown ? "opacity-100" : "opacity-0",
        )}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        <ViewTabs tabs={tabs} value={activeView} onChange={onToggleView} compact={compactTabs} />
        {presence && <PresenceChip presence={presence} className="min-w-0" />}
        {toolbar && <div className="ml-auto flex min-w-0 items-center gap-1.5">{toolbar}</div>}
        {controls && <div className={cn("flex shrink-0 items-center gap-1.5", !toolbar && "ml-auto")}>{controls}</div>}
      </div>
      <div
        data-testid="vm-stage"
        className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", SURFACE.well)}
      >
        {children}
      </div>
      {statusBar && (
        <div
          className={cn(MOTION.chromeFade, shown ? "opacity-100" : "opacity-0")}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {statusBar}
        </div>
      )}
    </div>
  );
}

/* ── Idle detector ───────────────────────────────────────────────────────── */

/**
 * True after `idleAfterMs` of no pointer or keyboard activity. Used only by
 * the desktop (watch mode) to fade the chrome. Any event resets the clock;
 * the timer is cleared on unmount. Reduced motion is honoured by the CSS
 * transition, not by skipping the fade: the bars still hide, they just do it
 * instantly, so the desk still gets out of the way.
 *
 * Any pointer movement over the frame also counts as activity: the fade only
 * resumes once the pointer has left the stage too, so moving toward the faded
 * bar reveals it (hover) and then keeps it (activity).
 */
export function useIdleChrome(
  active: boolean,
  frameRef?: React.RefObject<HTMLElement | null>,
  idleAfterMs = MOTION.idleAfterMs,
): boolean {
  const [idle, setIdle] = useState(false);
  React.useEffect(() => {
    if (!active) {
      setIdle(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      setIdle(false);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // The pointer resting over the frame keeps the chrome up: the user may
        // be about to click a control.
        const frame = frameRef?.current;
        if (frame && frame.matches(":hover")) {
          arm();
          return;
        }
        setIdle(true);
      }, idleAfterMs);
    };
    arm();
    const events: Array<keyof WindowEventMap> = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"];
    for (const name of events) window.addEventListener(name, arm, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, arm);
    };
  }, [active, frameRef, idleAfterMs]);
  return active && idle;
}
