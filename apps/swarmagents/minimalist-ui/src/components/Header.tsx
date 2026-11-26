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
import Link from "next/link";
import { ChevronDown, HelpCircle, Plug, Settings as SettingsIcon, Square, SquarePen } from "lucide-react";
import { MascotDock } from "../../../components/mascot/MascotDock";
import type { MascotState } from "../../../components/mascot/frames";
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
        className="neo-pill flex h-8 min-w-0 items-center gap-1.5 sm:gap-2 rounded-full border border-white/[0.12] bg-zinc-950/60 px-2.5 sm:px-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12)] backdrop-blur-xl transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-white/20"
      >
        <span role="status" className="flex min-w-0">
          <StatusPill tone={RUN_TONE_TO_PILL[meta.tone]} live={meta.active}>
            {meta.label}
          </StatusPill>
        </span>
        {meta.active && since !== undefined ? (
          <Elapsed since={since} className="hidden sm:inline text-xs text-[var(--ok)] mono" />
        ) : (
          durationMs !== undefined && (
            <span className="mono hidden text-[12px] text-[var(--mute)] sm:inline tabular-nums">
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
  /** Optional authenticated user summary for top-right Sign in / Account pill. */
  user?: { email?: string | null; name?: string | null } | null;
  /** The account's 24/7 always-on VM mode (shows the live badge when on). */
  alwaysOn247?: boolean;
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
  user,
  alwaysOn247 = false,
}: HeaderProps) {
  return (
    <header className="glass shrink-0 hair-b relative z-30" data-testid="workspace-header">
      <div
        className={cn(
          "grid h-13 items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4",
          wide ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_auto]",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2 overflow-hidden">
          {/* Brand mark + wordmark (branding/BRAND.md) */}
          <span className="flex shrink-0 items-center gap-2" data-testid="brand-lockup">
            <img src="/brand/mark-dark.svg" alt="" width={28} height={28} className="h-6 w-6 sm:h-7 sm:w-7 shrink-0 drop-shadow-[0_0_10px_rgba(0,208,240,0.45)]" />
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
            className="press neo-pill flex h-8 sm:h-9 min-w-0 max-w-[116px] sm:max-w-[230px] items-center gap-1 rounded-xl px-2 sm:px-2.5 text-xs sm:text-sm font-medium text-[var(--fg)]"
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
            className="neo-pill h-8 w-8 sm:h-9 sm:w-9 shrink-0 rounded-xl"
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
              className="glass neo-well rounded-2xl p-1"
            />
          </div>
        )}

        <div className="flex shrink-0 items-center justify-end gap-1 sm:gap-2">
          {alwaysOn247 && (
            <span
              data-testid="always-on-247-pill"
              title="Always-On 24/7: your VM stays live and self-heals"
              className="hidden shrink-0 items-center rounded-full bg-emerald-400/15 px-2 py-1 font-mono text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30 min-[420px]:inline-flex"
            >
              24/7
            </span>
          )}
          <RunIndicator {...run} />
          <Link
            href="/connectors"
            aria-label="Connectors"
            title="Connector Catalog"
            data-testid="open-connectors"
            className="press neo-pill flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-xl text-[var(--mute)] hover:text-[var(--fg)]"
          >
            <Plug className="h-4 w-4" aria-hidden />
          </Link>
          <IconButton
            label="Keyboard shortcuts"
            onClick={onOpenShortcuts}
            data-testid="open-shortcuts"
            className="neo-pill hidden sm:grid h-9 w-9 shrink-0 rounded-xl"
          >
            <HelpCircle className="h-4 w-4" aria-hidden />
          </IconButton>
          <IconButton
            label="Settings"
            onClick={onOpenSettings}
            data-testid="open-settings"
            className="neo-pill h-8 w-8 sm:h-9 sm:w-9 shrink-0 rounded-xl"
          >
            <SettingsIcon className="h-4 w-4" aria-hidden />
          </IconButton>
          {user ? (
            <Link
              href="/login"
              data-testid="header-account"
              title={user.email || user.name || "Account"}
              className="press neo-pill flex h-8 sm:h-9 max-w-[74px] sm:max-w-[140px] shrink-0 items-center gap-1.5 rounded-xl px-2 sm:px-3 text-xs font-medium text-[var(--fg)]"
            >
              <span className="truncate">{user.name || user.email || "Account"}</span>
            </Link>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5">
              <Link
                href="/login"
                data-testid="header-sign-in"
                className="press neo-pill flex h-8 sm:h-9 items-center rounded-xl px-2 sm:px-3 text-xs font-medium text-[var(--fg)]"
              >
                Sign in
              </Link>
              <Link
                href="/login?mode=signup"
                data-testid="header-sign-up"
                className="press hidden sm:flex h-9 items-center rounded-xl border border-cyan-400/40 bg-cyan-400/15 px-3 text-xs font-medium text-cyan-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_0_18px_-6px_rgba(0,208,240,0.4)] transition-all hover:bg-cyan-400/25"
              >
                Sign up
              </Link>
            </div>
          )}
        </div>
      </div>

      {!wide && (
        <div className="flex justify-center hair-t bg-black/20 px-3 py-1.5 backdrop-blur-xl">
          <Segmented<WorkspaceView> label="Views" options={views} value={view} onChange={onView} className="w-full justify-center glass neo-well rounded-xl p-0.5" />
        </div>
      )}
    </header>
  );
}

export default Header;
