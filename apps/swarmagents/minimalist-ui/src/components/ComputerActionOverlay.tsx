"use client";

/**
 * ComputerActionOverlay — the "what did the agent just touch" layer on the
 * live desktop.
 *
 * A parsed computer-use action (see lib/client/presence.ts) becomes:
 *
 *   - a click ripple: an expanding ring + center dot at the action's
 *     framebuffer coordinates, for click / double_click;
 *   - a cursor reticle: a pulsing ring + crosshair at the coordinates, for
 *     move (and for click kinds once the ripple has played out, the dot
 *     stays while the chip lingers);
 *   - a floating HUD chip, bottom-left of the frame, naming the action
 *     ("Clicking (640, 420)", "Typing…") — for every kind, including the
 *     ones with no screen target (type, navigate, screenshot, scroll,
 *     keypress). The chip also carries the action effect (core-35): an
 *     amber "no change" warning when the tool reported no visible change,
 *     a "focus → <title>" suffix when focus moved, and a "Loop caught"
 *     flash when the harness nudged the agent off a repeated no-op
 *     (watchdog.loop).
 *
 * The whole layer is `pointer-events-none` and `aria-hidden`: it can never
 * intercept a human takeover click, and it is decorative — the same action
 * is already narrated in the activity strip. Actions older than the fresh
 * window never render, so a replayed stream does not paint phantom ripples.
 */

import { useEffect, useState } from "react";
import { cn } from "../utils/cn";
import {
  computerActionLabel,
  DESKTOP_FRAMEBUFFER,
  type ComputerAction,
} from "../../../lib/client/presence";

/** Ripples are for actions happening now, not replays of old ones. */
export const COMPUTER_ACTION_FRESH_MS = 5_000;
/** How long the chip lingers after the action (the ripple itself is ~900ms). */
export const COMPUTER_ACTION_LINGER_MS = 4_000;
/** How long a watchdog.loop nudge flashes on the chip. */
export const COMPUTER_LOOP_FLASH_MS = 4_000;

function isFresh(action: ComputerAction | undefined, now = Date.now()): boolean {
  return !!action && now - action.at < COMPUTER_ACTION_FRESH_MS;
}

function isFreshLoop(loopNudgeAt: number | undefined, now = Date.now()): boolean {
  return loopNudgeAt !== undefined && now - loopNudgeAt < COMPUTER_LOOP_FLASH_MS;
}

export function ComputerActionOverlay({
  action,
  loopNudgeAt,
}: {
  action?: ComputerAction;
  /** Epoch ms of the newest watchdog.loop nudge; flashes the chip (core-21). */
  loopNudgeAt?: number;
}) {
  // Synchronous initial state so server/static renders show a fresh action
  // (effects do not run there); the timer below only hides it afterwards.
  const [visible, setVisible] = useState(() => isFresh(action));
  const [loopFlash, setLoopFlash] = useState(() => isFreshLoop(loopNudgeAt));

  useEffect(() => {
    if (!action || !isFresh(action)) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const linger = Math.max(0, COMPUTER_ACTION_LINGER_MS - (Date.now() - action.at));
    const timer = setTimeout(() => setVisible(false), linger);
    return () => clearTimeout(timer);
  }, [action]);

  useEffect(() => {
    if (!isFreshLoop(loopNudgeAt)) {
      setLoopFlash(false);
      return;
    }
    setLoopFlash(true);
    const linger = Math.max(0, COMPUTER_LOOP_FLASH_MS - (Date.now() - loopNudgeAt!));
    const timer = setTimeout(() => setLoopFlash(false), linger);
    return () => clearTimeout(timer);
  }, [loopNudgeAt]);

  if ((!action || !visible) && !loopFlash) return null;

  const showAction = !!action && visible;
  const framebuffer = action?.framebuffer ?? DESKTOP_FRAMEBUFFER;
  const hasPoint = showAction && action.x !== undefined && action.y !== undefined;
  const left = hasPoint ? `${(action.x! / framebuffer.width) * 100}%` : undefined;
  const top = hasPoint ? `${(action.y! / framebuffer.height) * 100}%` : undefined;
  const isClick =
    showAction && (action.kind === "click" || action.kind === "double_click");

  const effect = showAction ? action.effect : undefined;
  const noChange = effect?.changed === false;
  const focusTitle = effect?.focus;

  return (
    <div
      aria-hidden
      data-testid="computer-action-overlay"
      data-action-kind={action?.kind}
      className="pointer-events-none absolute inset-0 z-[6]"
    >
      {hasPoint && (
        <div
          className="absolute transition-[left,top] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ left, top, transform: "translate(-50%, -50%)" }}
          data-testid="computer-action-point"
          data-a1-cursor={action.kind}
          data-x={action.x}
          data-y={action.y}
        >
          {isClick ? (
            <span className="sa-click-ripple block h-10 w-10 rounded-full border-2 border-sky-300/80 bg-sky-400/15" />
          ) : (
            <span className="sa-reticle-pulse relative block h-7 w-7">
              <span className="absolute inset-0 rounded-full border border-sky-300/75" />
              <span className="absolute left-1/2 top-1/2 h-px w-3 -translate-x-1/2 -translate-y-1/2 bg-sky-200/85" />
              <span className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-sky-200/85" />
            </span>
          )}
          {/* Center dot: marks the exact pixel while the chip lingers. */}
          <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_8px_rgba(56,189,248,0.85)]" />
          {/* Crisp A1 pointer + floating micro-action pill */}
          <svg
            width="18"
            height="22"
            viewBox="0 0 20 24"
            fill="none"
            className="absolute left-1/2 top-1/2 -translate-x-[3px] -translate-y-[2px] drop-shadow-[0_2px_6px_rgba(0,0,0,0.65)]"
          >
            <path
              d="M3 2.5L16.5 12.6L10.4 13.6L13.9 20.9L11.3 22.1L7.9 14.8L3 19.1V2.5Z"
              fill="#f8fafc"
              stroke="#0ea5e9"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          <div className="absolute left-5 top-5 flex items-center gap-1.5 whitespace-nowrap rounded-full border border-white/[0.14] bg-zinc-950/70 py-[2px] pl-1 pr-2 text-[10px] font-medium text-white/90 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_8px_20px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            <span className="flex h-3.5 items-center rounded-full bg-sky-400 px-1.5 font-mono text-[9px] font-semibold text-zinc-950">
              A1
            </span>
            <span className="max-w-[140px] truncate text-white/80">{computerActionLabel(action)}</span>
          </div>
        </div>
      )}

      <div
        className={cn(
          "absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full border border-white/[0.14] bg-zinc-950/70 px-2.5 py-1 font-mono text-[11px] text-white/90 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-xl",
          loopFlash && "animate-pulse border-amber-400/50 text-amber-100",
          noChange && "border-amber-400/40",
        )}
        data-testid="computer-action-chip"
        data-typing-badge={showAction && action.kind === "type" ? "true" : undefined}
        data-effect-changed={effect ? String(effect.changed) : undefined}
        data-effect-focus={focusTitle}
        data-loop-flash={loopFlash ? "true" : undefined}
      >
        <span
          className={cn(
            "sa-reticle-pulse h-1.5 w-1.5 shrink-0 rounded-full",
            loopFlash || noChange ? "bg-amber-400" : "bg-sky-400",
          )}
        />
        <span className="text-white/50">A1</span>
        {showAction && computerActionLabel(action)}
        {noChange && (
          <span className="text-amber-300/90" data-testid="computer-action-effect">
            no change
          </span>
        )}
        {focusTitle && (
          <span className="max-w-[160px] truncate text-white/60" data-testid="computer-action-effect">
            focus → {focusTitle}
          </span>
        )}
        {loopFlash && (
          <span className="text-amber-200" data-testid="computer-action-loop">
            Loop caught — agent nudged
          </span>
        )}
      </div>
    </div>
  );
}
