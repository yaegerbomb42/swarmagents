"use client";

/**
 * TerminalView — the terminal, as a craft object rather than a log widget.
 *
 * What makes it read as swarmagents rather than a generic VNC client shell:
 *
 *   - a prompt header that names the session (`$ swarm · live agent
 *     session`), the way a real prompt names the host;
 *   - an emerald prompt gutter, and emerald only here (the shared chrome and
 *     status bar above and below stay graphite);
 *   - a presence wash on the newest line the agent wrote — a 900ms fade of
 *     the accent behind that row, so "where the agent is" is visible without
 *     anything moving or scrolling;
 *   - an input row framed by the terminal's own emerald hairline, with
 *     history on Up/Down and a visible stop control while a command runs.
 *
 * Speed: a run can stream thousands of events and the user must still be
 * able to type. Rows are keyed by seq and appended, so React never rebuilds
 * earlier rows; the input is a plain controlled input outside the stream
 * list; and the only cost of a new event is one appended row plus the
 * stick-to-bottom helper. The view is hidden — not unmounted — when another
 * tab is selected, so switching tabs never replays the transcript.
 */

import React from "react";
import { ArrowDown, Square } from "lucide-react";
import { useStickToBottom } from "../../../../lib/client/useStickToBottom";
import type { RunStreamState } from "../../../../lib/client/useRunStream";
import type { Presence } from "../../../../lib/client/presence";
import type { LogEvent } from "../../engine";
import { cn } from "../../utils/cn";
import { StreamRow } from "./streamRows";

/** Friendly empty state for the terminal when there are no events yet (t14r). */
export function TerminalEmptyState({
  title,
  hint,
}: {
  title: string;
  hint: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
      <img src="/brand/mark-dark.svg" alt="" width={48} height={48} />
      <div className="text-xs font-medium text-white/50">{title}</div>
      <div className="max-w-xs text-[11px] leading-relaxed text-white/30">{hint}</div>
    </div>
  );
}

export interface TerminalViewProps {
  /** The live agent run's stream, or null when no run is attached. */
  stream: Pick<RunStreamState, "status" | "items"> | null;
  /** The user's own shell run (POST /api/runtime/vm/exec), if any. */
  shellStream: Pick<RunStreamState, "status" | "items">;
  shellRunId?: string;
  /** Simulated logs, used only when no live run is attached. */
  logs: LogEvent[];
  runActive: boolean;
  vmResetting: boolean;
  presence: Presence;
  input: string;
  onInputChange: (value: string) => void;
  onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: (command: string) => void;
  onCancel: () => void;
  execBusy: boolean;
  execError?: string;
  runningShellRunId?: string;
}

export function TerminalView({
  stream,
  shellStream,
  shellRunId,
  logs,
  runActive,
  vmResetting,
  presence,
  input,
  onInputChange,
  onInputKeyDown,
  onSubmit,
  onCancel,
  execBusy,
  execError,
  runningShellRunId,
}: TerminalViewProps) {
  const liveRun = Boolean(stream);
  const contentVersion = (stream?.items.length ?? 0) + shellStream.items.length + logs.length;
  const scroll = useStickToBottom(contentVersion);
  const lastSeq = stream && stream.items.length > 0 ? stream.items[stream.items.length - 1].seq : -1;
  const busy = execBusy || Boolean(runningShellRunId);
  // The agent's own command, shown as a dim live command line under the
  // prompt while the run works — the terminal "types along" with the agent
  // instead of only listing rows.
  const liveCommand =
    !busy && presence.runState === "working" && presence.command ? presence.command : undefined;
  // The header tells the truth about the run, not just whether a run is
  // attached: a finished run is not "streaming".
  const liveNow = liveRun && presence.runState === "working";
  const finishedRun = liveRun && !liveNow;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="vm-terminal">
      {/* The terminal's signature: a prompt header, not a toolbar. */}
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-emerald-400/10 bg-black/30 px-3 font-mono text-[10.5px] text-white/40">
        <span className="select-none text-emerald-400/80">$</span>
        <span className="truncate">
          {liveNow ? "swarm · live agent session" : finishedRun ? "swarm · last agent run" : "swarm · interactive shell"}
        </span>
        <span className="ml-auto hidden shrink-0 items-center gap-1.5 sm:flex">
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              liveNow ? "bg-emerald-400 sa-dot-live" : finishedRun ? "bg-emerald-400/40" : "bg-white/25",
            )}
          />
          {liveNow ? "streaming" : finishedRun ? "finished" : "ready"}
        </span>
      </div>

      <div
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="flex-1 space-y-1.5 overflow-y-auto p-4 font-mono text-xs scrollbar-thin"
      >
        {liveRun ? (
          <>
            {/* Approvals live in their own layer above the screen; they are
                not part of this scroll. */}
            {stream!.status === "reconnecting" && (
              <div className="text-amber-400/60">reconnecting to run stream…</div>
            )}
            {stream!.items.length === 0 ? (
              finishedRun ? (
                <TerminalEmptyState
                  title="This run left no terminal events"
                  hint="The agent ran without shell output — its chat reply has what changed."
                />
              ) : (
                <TerminalEmptyState
                  title="Warming up the terminal"
                  hint="Once the agent starts, its live terminal events will stream in here."
                />
              )
            ) : (
              stream!.items.map((item) => (
                <StreamRow
                  key={item.seq}
                  item={item}
                  live={item.seq === lastSeq && presence.runState === "working"}
                />
              ))
            )}
          </>
        ) : logs.length === 0 ? (
          <TerminalEmptyState
            title="Ready when you are"
            hint="Run an agent or interact with the computer — terminal output will appear here."
          />
        ) : (
          logs.map((log, index) => (
            <div key={index} className="flex gap-2">
              <span className="select-none text-white/30">$</span>
              <span style={{ color: `hsl(${log.hue} 85% 75%)` }}>[{log.agent}]</span>
              <span className="text-white/80">{log.msg}</span>
            </div>
          ))
        )}

        {/* The user's own commands: the shell run streams independently of
            the agent run. `run.created` is skipped — the `$` echo of the
            command is the line the user actually sees. */}
        {shellRunId && (
          <>
            {shellStream.status === "reconnecting" && (
              <div className="text-amber-400/60">reconnecting to shell stream…</div>
            )}
            {shellStream.items
              .filter((item) => item.kind !== "run.created")
              .map((item) => (
                <StreamRow key={item.seq} item={item} />
              ))}
          </>
        )}
      </div>

      {/* Shown once the user scrolls up: jump back to the latest output and
          re-engage sticking to the bottom (q5). */}
      {!scroll.stuck && (
        <button
          type="button"
          onClick={scroll.jumpToLatest}
          className="absolute bottom-14 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-[#101015]/95 px-3 py-1.5 font-mono text-[11px] text-emerald-300 shadow-lg backdrop-blur transition hover:bg-emerald-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
        >
          <ArrowDown className="h-3 w-3" />
          Jump to latest
        </button>
      )}

      {liveCommand && (
        <div
          data-testid="terminal-agent-command"
          className="flex shrink-0 items-center gap-2 border-t border-emerald-400/10 bg-black/25 px-4 py-1.5 font-mono text-[11px] text-white/45"
        >
          <span className="select-none text-emerald-400/60" aria-hidden>
            ›
          </span>
          <span className="shrink-0 text-emerald-300/60">agent</span>
          <span className="min-w-0 truncate text-white/70">{liveCommand}</span>
          <span aria-hidden className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-emerald-400/60" />
        </div>
      )}
      <form
        className="flex shrink-0 items-center gap-2 border-t border-emerald-400/15 bg-[#091009] px-4 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(input);
        }}
      >
        <span className="select-none font-mono text-xs text-emerald-400/80">$</span>
        <input
          type="text"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={busy ? "running… (Ctrl-C to stop)" : "type a command for your computer"}
          disabled={vmResetting}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Terminal command"
          className="min-w-0 flex-1 border-none bg-transparent font-mono text-xs text-white/90 placeholder:text-white/25 focus:outline-none"
        />
        {busy && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-rose-400/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] text-rose-300 transition-colors hover:bg-rose-500/20"
          >
            <Square className="h-2.5 w-2.5 fill-current" /> stop
          </button>
        )}
      </form>
      {execError && (
        <div className="shrink-0 border-t border-rose-500/20 bg-rose-500/10 px-4 py-1.5 font-mono text-[11px] text-rose-300/90">
          {execError}
        </div>
      )}
    </div>
  );
}
