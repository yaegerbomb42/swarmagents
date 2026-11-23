"use client";

/**
 * Mascot — Jimmy, rendered from the 8x8 sprite sheet.
 *
 * The sheet is drawn as a CSS background on a single fixed-size frame and
 * stepped with `background-position`. That keeps the component dependency-free
 * (no image element, no canvas, no animation library) and pixel-crisp at any
 * `size`, including 2x displays.
 *
 * Playback rules:
 *   - hello plays 0-10 once, then settles into idle;
 *   - idle loops 11-15 with an occasional blink-length hold;
 *   - working loops 24-63, attention loops 16-23.
 *
 * `prefers-reduced-motion` (or the `reducedMotion` test override) pins the
 * mascot to the first frame of its state and disables the entrance transition.
 */

import React, { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import {
  MASCOT_COLUMNS,
  MASCOT_FRAME_HEIGHT,
  MASCOT_FRAME_MS,
  MASCOT_FRAME_WIDTH,
  MASCOT_ROWS,
  MASCOT_SHEET,
  advanceMascotFrame,
  framePosition,
  frameRangeFor,
  stillFrameFor,
  type MascotState,
} from "./frames";

export interface MascotProps {
  /** Which animation range to play. Defaults to idle. */
  state?: MascotState;
  /** Width of one frame in CSS pixels (the height follows the 192:153 ratio). */
  size?: number;
  /** When provided, the mascot is clickable (and waves when clicked by the page). */
  onClick?: () => void;
  /** Optional visually hidden status line, announced politely to screen readers. */
  label?: string;
  /** Accessible name for the click target. Defaults to "Wave hello". */
  clickLabel?: string;
  className?: string;
  /**
   * Override the `prefers-reduced-motion` media query. Exposed so the static
   * render tests can cover the reduced-motion branch without a DOM.
   */
  reducedMotion?: boolean;
}

export function Mascot({
  state = "idle",
  size = 96,
  onClick,
  label,
  clickLabel,
  className,
  reducedMotion,
}: MascotProps) {
  const prefersReduced = usePrefersReducedMotion();
  const motionReduced = reducedMotion ?? prefersReduced;

  const [playState, setPlayState] = useState<MascotState>(state);
  const [frame, setFrame] = useState(() => stillFrameFor(state));
  const [entered, setEntered] = useState(false);
  const previousState = useRef(state);

  // A new state prop restarts playback at that state's first frame. The hello
  // prop can stay "hello" while the internal player settles back into idle.
  useEffect(() => {
    if (previousState.current === state) return;
    previousState.current = state;
    setPlayState(state);
    setFrame(stillFrameFor(state));
  }, [state]);

  // Short pop-in on first mount. Reduced motion renders the final pose at once.
  useEffect(() => {
    if (motionReduced) {
      setEntered(true);
      return;
    }
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => setEntered(true))
        : setTimeout(() => setEntered(true), 0);
    return () => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf as number);
      else clearTimeout(raf as ReturnType<typeof setTimeout>);
    };
  }, [motionReduced]);

  // Frame stepping. One timer per step (not a fixed interval) so the idle
  // blink hold can stretch a single frame without drifting the frame clock.
  useEffect(() => {
    const range = frameRangeFor(playState);
    setFrame(range.start);
    if (motionReduced) return;

    let cancelled = false;
    let current = range.start;
    let completedLoops = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      if (cancelled) return;
      const step = advanceMascotFrame(playState, current, completedLoops);
      if (step.done) {
        // The wave is a one-shot: settle into the resting loop.
        setPlayState("idle");
        return;
      }
      current = step.frame;
      if (step.completedLoop) completedLoops += 1;
      setFrame(current);
      timer = setTimeout(tick, step.pause ? MASCOT_FRAME_MS * 2 : MASCOT_FRAME_MS);
    };

    timer = setTimeout(tick, MASCOT_FRAME_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [playState, motionReduced]);

  // Integer frame dimensions keep the sprite on whole device pixels at 1x and
  // 2x; imageRendering: "pixelated" stops the 192px art from going soft.
  const frameHeight = Math.round((size * MASCOT_FRAME_HEIGHT) / MASCOT_FRAME_WIDTH);
  const { col, row } = framePosition(frame);
  const statusLabel = label;

  const sprite = (
    <span
      aria-hidden="true"
      data-testid="mascot-sprite"
      data-frame={frame}
      style={{
        display: "block",
        width: size,
        height: frameHeight,
        backgroundColor: "transparent",
        backgroundImage: `url(${MASCOT_SHEET})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${size * MASCOT_COLUMNS}px ${frameHeight * MASCOT_ROWS}px`,
        backgroundPosition: `${-col * size}px ${-row * frameHeight}px`,
        imageRendering: "pixelated",
      }}
    />
  );

  const entranceStyle: React.CSSProperties = {
    display: "inline-block",
    lineHeight: 0,
    opacity: entered || motionReduced ? 1 : 0,
    transform: entered || motionReduced ? "none" : "translateY(6px) scale(0.9)",
    transition: motionReduced ? "none" : "opacity 220ms ease-out, transform 220ms ease-out",
  };

  return (
    <span
      data-testid="mascot"
      data-mascot-state={playState}
      data-mascot-reduced={motionReduced ? "true" : "false"}
      aria-hidden={!onClick && !statusLabel ? "true" : undefined}
      className={className}
      style={entranceStyle}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={clickLabel ?? "Wave hello"}
          className="grid place-items-center rounded-2xl transition-transform duration-150 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 active:scale-95"
          style={{ lineHeight: 0 }}
        >
          {sprite}
        </button>
      ) : (
        sprite
      )}
      {statusLabel ? (
        <span className="sr-only" role="status">
          {statusLabel}
        </span>
      ) : null}
    </span>
  );
}

export default Mascot;
