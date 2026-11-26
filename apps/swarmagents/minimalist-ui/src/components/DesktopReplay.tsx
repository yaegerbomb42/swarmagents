"use client";

/**
 * DesktopReplay — plays the frame recorder's RFB capture for a finished run.
 *
 * The bytes come from the owner-only run-report replay route. Decoding happens
 * locally (lib/client/desktop-replay); no input is ever replayed, and the
 * canvas is display-only. Playback starts on the last frame, like a finished
 * recording, and the scrubber can walk back through every recorded update.
 */

import { useEffect, useRef, useState } from "react";
import {
  applyReplayUpdate,
  createReplayFramebuffer,
  parseDesktopReplay,
  REPLAY_FRAME_INTERVAL_MS,
  type ReplayUpdate,
} from "../../../lib/client/desktop-replay";
import { Button } from "./ui";

export interface DesktopReplayProps {
  runId: string;
  url?: string;
  width?: number;
  height?: number;
}

export function desktopReplayUrl(runId: string): string {
  return `/api/runtime/runs/${encodeURIComponent(runId)}/report/replay`;
}

export function DesktopReplay({
  runId,
  url,
  width = 1600,
  height = 900,
}: DesktopReplayProps) {
  const [updates, setUpdates] = useState<ReplayUpdate[] | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixelsRef = useRef<Uint8ClampedArray | null>(null);
  const drawnRef = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    setUpdates(null);
    setBytes(null);
    setError(undefined);
    setPlaying(false);
    setIndex(0);
    fetch(url ?? desktopReplayUrl(runId))
      .then((res) => {
        if (!res.ok) throw new Error(`replay unavailable (${res.status})`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        if (cancelled) return;
        const source = new Uint8Array(buffer);
        const parsed = parseDesktopReplay(source);
        pixelsRef.current = createReplayFramebuffer(width, height);
        drawnRef.current = -1;
        setBytes(source);
        setUpdates(parsed);
        setIndex(Math.max(0, parsed.length - 1));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "replay unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [runId, url, width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !updates || !bytes || !pixelsRef.current) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (index < drawnRef.current || drawnRef.current < 0) {
      pixelsRef.current = createReplayFramebuffer(width, height);
      drawnRef.current = -1;
    }
    for (let i = drawnRef.current + 1; i <= index; i++) {
      applyReplayUpdate(pixelsRef.current, width, height, updates[i], bytes);
    }
    drawnRef.current = index;
    const image = ctx.createImageData(width, height);
    image.data.set(pixelsRef.current);
    ctx.putImageData(image, 0, 0);
  }, [updates, bytes, index, width, height]);

  useEffect(() => {
    if (!playing || !updates || updates.length === 0) return;
    const timer = setInterval(() => setIndex((i) => Math.min(i + 1, updates.length - 1)), REPLAY_FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, updates]);

  useEffect(() => {
    if (updates && index >= updates.length - 1) setPlaying(false);
  }, [updates, index]);

  const count = updates?.length ?? 0;

  return (
    <div data-testid="desktop-replay">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[13px] font-medium text-sa-fg">Desktop replay</span>
        <span className="sa-tabular text-[11px] text-sa-fg3">{count > 0 ? `${count} frames` : ""}</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-sa-line bg-black">
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="block aspect-video w-full object-contain"
          data-testid="desktop-replay-canvas"
          aria-label="Recorded desktop screen"
        />
      </div>
      {error ? (
        <p className="mt-1 text-[12px] text-sa-fg2">{error}</p>
      ) : count === 0 ? (
        <p className="mt-1 text-[12px] text-sa-fg2">Loading desktop replay…</p>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (index >= count - 1) {
                setIndex(0);
                drawnRef.current = -1;
              }
              setPlaying((value) => !value);
            }}
          >
            {playing ? "Pause" : "Play"}
          </Button>
          <input
            type="range"
            min={0}
            max={Math.max(0, count - 1)}
            value={index}
            onChange={(event) => setIndex(Number(event.target.value))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-sa-accent"
            aria-label="Scrub desktop replay"
          />
          <span className="sa-tabular shrink-0 pl-1 text-[12px] text-sa-fg3">
            {index + 1} / {count}
          </span>
        </div>
      )}
    </div>
  );
}
