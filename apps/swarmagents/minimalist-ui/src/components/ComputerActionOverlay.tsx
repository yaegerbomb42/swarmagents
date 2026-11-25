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
 *     keypress).
 *
 * The whole layer is `pointer-events-none` and `aria-hidden`: it can never
 * intercept a human takeover click, and it is decorative — the same action
 * is already narrated in the activity strip. Actions older than the fresh
 * window never render, so a replayed stream does not paint phantom ripples.
 */

import { useEffect, useState } from "react";
import {
  computerActionLabel,
  DESKTOP_FRAMEBUFFER,
  type ComputerAction,
} from "../../../lib/client/presence";

/** Ripples are for actions happening now, not replays of old ones. */
export const COMPUTER_ACTION_FRESH_MS = 5_000;
/** How long the chip lingers after the action (the ripple itself is ~900ms). */
export const COMPUTER_ACTION_LINGER_MS = 4_000;

function isFresh(action: ComputerAction | undefined, now = Date.now()): boolean {
  return !!action && now - action.at < COMPUTER_ACTION_FRESH_MS;
}

export function ComputerActionOverlay({ action }: { action?: ComputerAction }) {
  // Synchronous initial state so server/static renders show a fresh action
  // (effects do not run there); the timer below only hides it afterwards.
  const [visible, setVisible] = useState(() => isFresh(action));

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

  if (!action || !visible) return null;

  const framebuffer = action.framebuffer ?? DESKTOP_FRAMEBUFFER;
  const hasPoint = action.x !== undefined && action.y !== undefined;
  const left = hasPoint ? `${(action.x! / framebuffer.width) * 100}%` : undefined;
  const top = hasPoint ? `${(action.y! / framebuffer.height) * 100}%` : undefined;
  const isClick = action.kind === "click" || action.kind === "double_click";

  return (
    <div
      aria-hidden
      data-testid="computer-action-overlay"
      data-action-kind={action.kind}
      className="pointer-events-none absolute inset-0 z-[6]"
    >
      {hasPoint && (
        <div
          className="absolute"
          style={{ left, top, transform: "translate(-50%, -50%)" }}
          data-testid="computer-action-point"
          data-x={action.x}
          data-y={action.y}
        >
          {isClick ? (
            <span className="sa-click-ripple block h-10 w-10 rounded-full border-2 border-white/90" />
          ) : (
            <span className="sa-reticle-pulse relative block h-7 w-7">
              <span className="absolute inset-0 rounded-full border border-white/80" />
              <span className="absolute left-1/2 top-1/2 h-px w-3 -translate-x-1/2 -translate-y-1/2 bg-white/80" />
              <span className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-white/80" />
            </span>
          )}
          {/* Center dot: marks the exact pixel while the chip lingers. */}
          <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
        </div>
      )}

      <div
        className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 font-mono text-[11px] text-white/85 backdrop-blur"
        data-testid="computer-action-chip"
      >
        <span className="sa-reticle-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-300" />
        {computerActionLabel(action)}
      </div>
    </div>
  );
}
