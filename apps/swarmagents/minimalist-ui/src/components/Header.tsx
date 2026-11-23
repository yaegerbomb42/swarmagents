"use client";

/**
 * Header — the workspace's primary bar on the brand system.
 *
 * Left: the cursor-eye mark + wordmark, the open conversation (opens
 * history), New chat.
 * Middle: Segmented view switcher (Chat, Computer, Board).
 * Right: Live run status indicator and Settings.
 */

import React from "react";
import { ChevronDown, HelpCircle, Settings as SettingsIcon, Square, SquarePen, Activity, Monitor, MessageSquare, ClipboardList } from "lucide-react";
import { RUN_PHASE_META, formatDuration, type RunPhase, type StatusTone } from "../../../lib/client/runPhase";
import { cn } from "../utils/cn";
import { Elapsed } from "./Conversation";
import { StatusPill, type PillTone } from "../design/primitives";
import { Button, IconButton, Segmented, type SegmentOption } from "./ui";

/** Run phases speak in five tones; the brand pill speaks in five of its own. */
export const RUN_TONE_TO_PILL: Record<StatusTone, PillTone> = {
  accent: "running",
  ok: "ok",
  warn: "warn",
  err: "err",
  muted: "neutral",
};

export type WorkspaceView = "chat" | "screen" | "board";

export interface RunIndicatorProps {
  phase: RunPhase | null;
  /** Epoch ms the run was created (for the running clock). */
  since?: number;
  /** How long a finished run took, in ms. */
  durationMs?: number;
  activity?: string;
  stopping: boolean;
  onStop: () => void;
  /** Go to the run (its screen while it runs, its result once it ends). */
  onShow: () => void;
}

export function RunIndicator({ phase, since, durationMs, activity, stopping, onStop, onShow }: RunIndicatorProps) {
  if (!phase) return null;
  const meta = RUN_PHASE_META[phase];
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-testid="run-indicator" data-phase={phase}>
      <button
        type="button"
        onClick={onShow}
        title={meta.active ? "Show the run" : "Show the result"}
        className="flex h-8 min-w-0 items-center gap-2 rounded-xl hair px-2.5 bg-black/30 transition-colors hover:bg-white/[0.06]"
      >
        <span role="status" className="flex min-w-0">
          <StatusPill tone={RUN_TONE_TO_PILL[meta.tone]} live={meta.active}>
            {meta.label}
          </StatusPill>
        </span>
        {meta.active && since !== undefined ? (
          <Elapsed since={since} className="hidden min-[420px]:inline text-xs text-[var(--ok)] mono" />
        ) : (
          durationMs !== undefined && (
            <span className="mono hidden text-[12px] text-[var(--mute)] min-[420px]:inline tabular-nums">
              {formatDuration(durationMs)}
            </span>
          )
        )}
        {phase === "running" && activity && (
          <span className="hidden max-w-[220px] truncate text-[12px] text-[var(--mute)] xl:inline" data-testid="run-activity">
            {activity}
          </span>
        )}
      </button>
      {meta.active && (
        <Button size="sm" variant="danger" loading={stopping} onClick={onStop} data-testid="stop-run" className="rounded-xl">
          {!stopping && <Square className="h-3 w-3 fill-current" aria-hidden />}
          Stop
        </Button>
      )}
    </div>
  );
}

export interface HeaderProps {
  title: string;
  onOpenHistory: () => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
  views: SegmentOption<WorkspaceView>[];
  view: WorkspaceView | undefined;
  onView: (view: WorkspaceView) => void;
  wide: boolean;
  run: RunIndicatorProps;
  onOpenSettings: () => void;
  settingsNeedsAttention: boolean;
  /** Opens the keyboard-shortcuts help panel. */
  onOpenShortcuts: () => void;
}

export function Header({
  title,
  onOpenHistory,
  onNewChat,
  newChatDisabled,
  views,
  view,
  onView,
  wide,
  run,
  onOpenSettings,
  settingsNeedsAttention,
  onOpenShortcuts,
}: HeaderProps) {
  return (
    <header className="glass shrink-0 hair-b relative z-30" data-testid="workspace-header">
      <div
        className={cn(
          "grid h-13 items-center gap-2 px-3 sm:px-4",
          wide ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_auto]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* Brand mark + wordmark (branding/BRAND.md) */}
          <span className="flex shrink-0 items-center gap-2" data-testid="brand-lockup">
            <img src="/brand/mark-dark.svg" alt="" width={28} height={28} className="shrink-0" />
            <span className="hidden text-[15px] font-semibold tracking-tight text-[var(--fg)] min-[560px]:inline">
              SwarmAgents
            </span>
          </span>

          <button
            type="button"
            onClick={onOpenHistory}
            data-testid="open-history"
            aria-haspopup="dialog"
            title="Conversations"
            className="press flex h-9 min-w-0 items-center gap-1.5 rounded-xl hair bg-black/20 px-2.5 text-sm font-medium text-[var(--fg)] transition-colors hover:bg-white/[0.06]"
          >
            <span className="truncate" data-testid="thread-title">
              {title}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--mute)]" aria-hidden />
          </button>

          <IconButton
            label="New chat"
            onClick={onNewChat}
            disabled={newChatDisabled}
            data-testid="new-chat"
            className="rounded-xl hair bg-black/20 hover:bg-white/[0.06]"
          >
            <SquarePen className="h-4 w-4" aria-hidden />
          </IconButton>
        </div>

        {wide && (
          <div className="flex justify-center">
            <Segmented<WorkspaceView>
              label="Views"
              options={views}
              value={view}
              onChange={onView}
              className="glass hair rounded-2xl p-1"
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <RunIndicator {...run} />
          <IconButton
            label="Keyboard shortcuts"
            onClick={onOpenShortcuts}
            data-testid="open-shortcuts"
            className="rounded-xl hair bg-black/20 hover:bg-white/[0.06]"
          >
            <HelpCircle className="h-4 w-4" aria-hidden />
          </IconButton>
          <IconButton
            label="Settings"
            onClick={onOpenSettings}
            data-testid="open-settings"
            className="rounded-xl hair bg-black/20 hover:bg-white/[0.06]"
          >
            <SettingsIcon className="h-4 w-4" aria-hidden />
          </IconButton>
        </div>
      </div>

      {!wide && (
        <div className="flex justify-center hair-t bg-black/20 px-3 py-1.5">
          <Segmented<WorkspaceView> label="Views" options={views} value={view} onChange={onView} className="w-full justify-center glass hair rounded-xl p-0.5" />
        </div>
      )}
    </header>
  );
}

export default Header;
