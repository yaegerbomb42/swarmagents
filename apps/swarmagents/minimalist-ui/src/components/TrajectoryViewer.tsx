"use client";

import React, { useEffect, useReducer, useState } from "react";
import type { SequencedEvent } from "../../../lib/telemetry/bus";
import type { RunReport } from "../../../lib/runtime/run-report-types";

export interface TrajectoryRecord {
  events: SequencedEvent[];
  report: RunReport | null;
  truncated: { droppedCount: number; throughSeq: number } | null;
}

export function parseTrajectoryRecord(contents: string): TrajectoryRecord {
  const events: SequencedEvent[] = [];
  let report: RunReport | null = null;
  let truncated: TrajectoryRecord["truncated"] = null;

  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    if (value.kind === "event" && value.event && typeof value.event === "object") {
      const event = value.event as Partial<SequencedEvent>;
      if (typeof event.seq === "number" && Number.isFinite(event.seq) && typeof event.ts === "number" && Number.isFinite(event.ts) && typeof event.type === "string") {
        events.push(event as SequencedEvent);
      }
    } else if (value.kind === "report" && value.report && typeof value.report === "object") {
      report = value.report as RunReport;
    } else if (value.kind === "truncated" && typeof value.droppedCount === "number" && typeof value.throughSeq === "number") {
      truncated = { droppedCount: value.droppedCount, throughSeq: value.throughSeq };
    }
  }

  events.sort((a, b) => a.seq - b.seq);
  return { events, report, truncated };
}

export function formatTrajectoryTime(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

export interface ReplayState {
  index: number;
  playing: boolean;
  speed: 1 | 2 | 4;
}

export type ReplayAction =
  | { type: "toggle"; total: number }
  | { type: "advance"; total: number }
  | { type: "seek"; index: number; total: number }
  | { type: "speed"; speed: 1 | 2 | 4 };

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case "toggle":
      if (action.total < 1) return { ...state, playing: false };
      if (state.playing) return { ...state, playing: false };
      return state.index >= action.total - 1
        ? { ...state, index: 0, playing: true }
        : { ...state, playing: true };
    case "advance": {
      const index = Math.min(Math.max(action.total - 1, 0), state.index + 1);
      return { ...state, index, playing: index < action.total - 1 };
    }
    case "seek": {
      const index = Math.max(0, Math.min(Math.max(action.total - 1, 0), Math.floor(action.index)));
      return { ...state, index, playing: false };
    }
    case "speed":
      return { ...state, speed: action.speed };
  }
}

export function replayDelay(currentTs: number, nextTs: number, speed: number): number {
  return Math.max(80, Math.min(5000, Math.max(0, nextTs - currentTs) / speed));
}

function eventSummary(event: SequencedEvent): string {
  const data = event.data;
  if (typeof data === "string") return data.slice(0, 1200);
  if (!data || typeof data !== "object") return data === undefined ? "No additional details" : String(data);
  const record = data as Record<string, unknown>;
  for (const key of ["text", "message", "command", "name", "reason", "detail"]) {
    if (typeof record[key] === "string" && record[key]) return `${key}: ${record[key]}`.slice(0, 1200);
  }
  try {
    return JSON.stringify(data).slice(0, 1200);
  } catch {
    return "Event details unavailable";
  }
}

export function TrajectoryPlayer({ record }: { record: TrajectoryRecord }) {
  const [state, dispatch] = useReducer(replayReducer, { index: 0, playing: false, speed: 1 });
  const events = record.events;
  const current = events[state.index];
  const origin = events[0]?.ts ?? 0;

  useEffect(() => {
    if (!state.playing || !current || state.index >= events.length - 1) return;
    const next = events[state.index + 1];
    const timer = setTimeout(() => dispatch({ type: "advance", total: events.length }), replayDelay(current.ts, next.ts, state.speed));
    return () => clearTimeout(timer);
  }, [current, events, state.index, state.playing, state.speed]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      {record.truncated && (
        <p role="status" className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-100">
          This record was capped. {record.truncated.droppedCount} earlier events through step {record.truncated.throughSeq} were omitted.
        </p>
      )}

      {record.report && (
        <section aria-label="Run report" className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Run report</h2>
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs capitalize text-zinc-300">{record.report.status}</span>
          </div>
          {record.report.finalText && <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-200">{record.report.finalText}</p>}
          <p className="mt-3 text-xs text-zinc-400">
            {record.report.steps.length} report steps · {record.report.artifacts.length} files changed
            {record.report.meta?.durationMs !== undefined && ` · ${(record.report.meta.durationMs / 1000).toFixed(1)}s`}
            {record.report.meta?.costUsd !== undefined && ` · $${record.report.meta.costUsd.toFixed(3)}`}
          </p>
          {record.report.steps.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-cyan-200">View report timeline</summary>
              <ol className="mt-2 space-y-1 text-xs text-zinc-300">
                {record.report.steps.map((step) => <li key={`${step.seq}-${step.kind}`}>{step.text}</li>)}
              </ol>
            </details>
          )}
          {record.report.artifacts.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-cyan-200">View changed files</summary>
              <ul className="mt-2 space-y-1 text-xs text-zinc-300">
                {record.report.artifacts.map((artifact) => <li key={artifact.rel} className="font-mono">{artifact.rel}</li>)}
              </ul>
            </details>
          )}
        </section>
      )}

      <section aria-label="Trajectory playback" className="rounded-xl border border-white/10 bg-[#0c0c10] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-zinc-500">Replay</p>
            <h2 className="mt-1 text-lg font-semibold">{current ? current.type.replace(/[._]/g, " ") : "No recorded events"}</h2>
          </div>
          {current && <span className="font-mono text-xs text-zinc-400">{formatTrajectoryTime(current.ts - origin)}</span>}
        </div>

        {current ? (
          <>
            <p className="mt-1 text-xs text-zinc-500">Step {state.index + 1} of {events.length} · sequence {current.seq}</p>
            <pre data-testid="replay-event-details" className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-3 font-mono text-xs leading-5 text-zinc-300">{eventSummary(current)}</pre>
          </>
        ) : (
          <p className="mt-3 text-sm text-zinc-400">This run has no replayable telemetry events.</p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label={state.playing ? "Pause replay" : "Play replay"}
            onClick={() => dispatch({ type: "toggle", total: events.length })}
            disabled={events.length < 2}
            className="rounded-md bg-cyan-300 px-3 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            {state.playing ? "Pause" : state.index >= events.length - 1 && events.length > 1 ? "Replay" : "Play"}
          </button>
          <div role="group" aria-label="Playback speed" className="flex items-center gap-1">
            {([1, 2, 4] as const).map((speed) => (
              <button
                key={speed}
                type="button"
                aria-pressed={state.speed === speed}
                onClick={() => dispatch({ type: "speed", speed })}
                className="rounded-md border border-white/10 px-2.5 py-2 text-xs text-zinc-300 aria-pressed:border-cyan-300/60 aria-pressed:text-cyan-100"
              >
                {speed}x
              </button>
            ))}
          </div>
          <label className="ml-auto flex min-w-48 flex-1 items-center gap-3 text-xs text-zinc-400">
            <span className="sr-only">Replay position</span>
            <input
              type="range"
              aria-label="Replay position"
              min={0}
              max={Math.max(events.length - 1, 0)}
              step={1}
              value={state.index}
              disabled={events.length < 2}
              onChange={(event) => dispatch({ type: "seek", index: Number(event.currentTarget.value), total: events.length })}
              className="w-full accent-cyan-300 disabled:opacity-40"
            />
            <span className="whitespace-nowrap">{events.length ? `${state.index + 1}/${events.length}` : "0/0"}</span>
          </label>
        </div>
      </section>
    </div>
  );
}

export function TrajectoryViewer({ runId }: { runId: string }) {
  const [record, setRecord] = useState<TrajectoryRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/runtime/runs/${encodeURIComponent(runId)}/trajectory`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "Trajectory not found." : `Unable to load trajectory (HTTP ${response.status}).`);
        return response.text();
      })
      .then((contents) => setRecord(parseTrajectoryRecord(contents)))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Unable to load trajectory.");
      });
    return () => controller.abort();
  }, [runId]);

  if (error) return <p role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/5 px-4 py-3 text-sm text-rose-200">{error}</p>;
  if (!record) return <p role="status" className="text-sm text-zinc-400">Loading trajectory…</p>;
  return <TrajectoryPlayer record={record} />;
}
