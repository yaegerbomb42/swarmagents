"use client";

/**
 * HandoffBanner — the workspace-level "the agent paused for you" banner.
 *
 * When the run blocks on ask_human_desktop (CAPTCHA, 2FA, SSO, a finicky
 * drag) this banner appears above the workspace in every view, so the pause
 * is never silent: the handoff card in the chat stream can scroll out of
 * reach, and the computer view shows nothing about a handoff on its own.
 *
 * Two actions, the full takeover loop:
 *   - "Take Control" jumps to the live desktop in control mode. The runtime
 *     has already paused the agent, so the takeover grants immediately.
 *   - "Hand Back to Agent" resolves the handoff; the run resumes with a
 *     compact post-handoff state summary as the tool result.
 */

import React from "react";
import { Hand, Loader2 } from "lucide-react";

export interface HandoffBannerHandoff {
  id: string;
  reason: string;
  description?: string;
}

export interface HandoffBannerProps {
  handoff: HandoffBannerHandoff;
  /** How many handoffs are outstanding (shows "+N more" when > 1). */
  total?: number;
  handingBack?: boolean;
  onTakeControl: () => void;
  onHandBack: () => void;
}

export function HandoffBanner({
  handoff,
  total = 1,
  handingBack = false,
  onTakeControl,
  onHandBack,
}: HandoffBannerProps) {
  return (
    <div
      role="status"
      data-testid="desktop-handoff-banner"
      className="z-20 flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-2"
    >
      <Hand className="h-4 w-4 shrink-0 text-amber-300" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-medium text-amber-100">
          Agent paused — it needs you on the desktop
        </span>
        <span className="ml-1.5 text-[12px] text-amber-200/80">
          {handoff.reason}
          {total > 1 ? ` (+${total - 1} more)` : ""}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="handoff-take-control"
          onClick={onTakeControl}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 py-1 text-[12px] font-medium text-amber-100 transition hover:bg-amber-500/30"
        >
          Take Control
        </button>
        <button
          type="button"
          data-testid="handoff-hand-back"
          disabled={handingBack}
          onClick={onHandBack}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-2.5 py-1 text-[12px] font-medium text-black transition hover:bg-amber-300 disabled:opacity-50"
        >
          {handingBack ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Hand className="h-3 w-3" aria-hidden />}
          Hand Back
        </button>
      </div>
    </div>
  );
}

export default HandoffBanner;
