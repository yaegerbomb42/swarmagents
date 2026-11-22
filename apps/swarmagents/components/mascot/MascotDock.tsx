"use client";

/**
 * MascotDock — the one placement hook the workspace page uses.
 *
 * It owns the "first load waves hello, then follows the run" behaviour so the
 * page only has to pass the derived state. Keeping this here means a future
 * main-page rewrite can move the dock without re-implementing the playback
 * handshake.
 *
 * It is also the single place that picks which mascot renderer is shown:
 * the original sprite sheet (`sprite`) or the procedural SVG (`svg`).
 */

import React, { useEffect, useState } from "react";
import { Mascot } from "./Mascot";
import { MascotSvg } from "./MascotSvg";
import { MASCOT_HELLO_MS, mascotStatusLabel, type MascotState } from "./frames";
import { segmentSeconds, svgStateForRun } from "./svg-timeline";
import { DEFAULT_MASCOT_VARIANT, type MascotVariant } from "./variant";

/** How long the greeting wave runs for each renderer. */
export function mascotWaveDurationMs(variant: MascotVariant): number {
  return variant === "svg" ? segmentSeconds("wave") * 1000 : MASCOT_HELLO_MS;
}

export interface MascotDockProps {
  /** Run-derived state: working / attention / idle. */
  state: MascotState;
  size?: number;
  /** Short friendly line shown next to him (e.g. when he needs attention). */
  message?: string;
  className?: string;
  /** Which renderer to use. Defaults to the original sprite sheet. */
  variant?: MascotVariant;
}

export function MascotDock({
  state,
  size = 56,
  message,
  className,
  variant = DEFAULT_MASCOT_VARIANT,
}: MascotDockProps) {
  // Jimmy waves on first mount, then follows the run state. Clicking him
  // replays the wave and drops back to the run state when it finishes.
  const [waving, setWaving] = useState(true);
  // A nonce, not `waving`, restarts the timer: setWaving(true) is a no-op
  // while already waving, so a re-click would otherwise not reset the wave.
  const [waveCount, setWaveCount] = useState(0);
  // The sprite sheet and the SVG take different lengths to finish the wave;
  // using the sprite duration for the SVG made it snap to idle mid-gesture.
  const helloMs = mascotWaveDurationMs(variant);

  useEffect(() => {
    if (!waving) return;
    const timer = setTimeout(() => setWaving(false), helloMs);
    return () => clearTimeout(timer);
  }, [waving, waveCount, helloMs]);

  const playState: MascotState = waving ? "hello" : state;
  const replayWave = () => {
    setWaveCount((count) => count + 1);
    setWaving(true);
  };

  return (
    <span className={className ? `inline-flex items-center gap-2 ${className}` : "inline-flex items-center gap-2"}>
      {variant === "svg" ? (
        <MascotSvg
          state={svgStateForRun(playState)}
          size={size}
          onClick={replayWave}
          label={mascotStatusLabel(playState)}
          clickLabel="Click Jimmy to wave hello"
        />
      ) : (
        <Mascot
          state={playState}
          size={size}
          onClick={replayWave}
          label={mascotStatusLabel(playState)}
          clickLabel="Click Jimmy to wave hello"
        />
      )}
      {message ? (
        <span className="max-w-[16rem] text-[11px] leading-4 text-zinc-400">{message}</span>
      ) : null}
    </span>
  );
}

export default MascotDock;
