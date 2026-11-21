"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, Terminal, Globe, FileText, MonitorPlay } from "lucide-react";
import type { LogEvent } from "../engine";
import { AnsiRenderer } from "../../../components/AnsiRenderer";
import { MascotSvg } from "../../../components/mascot/MascotSvg";
import { svgStateForRun } from "../../../components/mascot/svg-timeline";
import { getRunStreamBadge, useRunStream, type RunStreamBadgeTone, type RunStreamItem } from "../../../lib/client/useRunStream";
import {
  EMPTY_TERMINAL_HISTORY,
  sanitizeTerminalHistory,
  terminalHistoryReducer,
  terminalHistoryValue,
} from "../../../lib/client/terminalHistory";
import { useSessionPersisted } from "../store";
import { useStickToBottom } from "../../../lib/client/useStickToBottom";
import { lifecycleEventLine, redactEventData } from "../../../lib/client/runTimeline";
import {
  latestVmLifecycleEvent,
  resolveVmDisplayStatus,
  type VmDisplayState,
} from "../../../lib/client/vmStatus";
import type { VmStatus } from "../../../lib/vm/types";
import { FilesView } from "./FilesView";
import { BrowserView } from "./BrowserView";
import { DesktopView } from "./DesktopView";

export type ComputerView = "desktop" | "terminal" | "browser" | "files";

interface ComputerScreenProps {
  logs: LogEvent[];
  /**
   * When set, the terminal view renders the live runtime SSE stream for this
   * run instead of the simulated `logs`. Omit (or pass undefined) to keep the
   * current simulated terminal output.
   */
  runId?: string;
  activeView: ComputerView;
  onToggleView: (view: ComputerView) => void;
  onResetVm: () => void;
  vmResetting: boolean;
  activeRoleName: string;
  /** Called when a terminal command is accepted and a shell run starts. */
  onShellRunStarted?: (runId: string) => void;
  /** Stop the live agent run from the desktop takeover banner (optional). */
  onStopRun?: () => void;
  /** Polled VM state from App (single poller for the page). */
  polledVmStatus?: VmStatus;
  /**
   * False once the server confirms this deployment runs with desktop mode
   * off: the desktop tab is hidden and today's screen stays as it was.
   * Undefined/true keeps the desktop tab (optimistic default).
   */
  desktopMode?: boolean;
  /**
   * A workspace file to open in the Files tab (the Codebase drawer opens a
   * file of the map here).
   */
  filesOpenPath?: string;
  /**
   * Embedded mode drops the OS window titlebar, its own view switcher and the
   * fixed-height shell: the ScreenFrame supplies all of that and gives this
   * component the 16:10 stage to fill.
   */
  embedded?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOOL_SUMMARY_LIMIT = 120;

/**
 * One human line for a tool call: the tool's short name plus its key
 * argument only (the file path, the command, the search pattern, the URL).
 * The full input JSON lives behind the collapsed Details disclosure, never
 * on the main surface.
 */
export function toolCallSummary(name: string, input: unknown): string {
  const short = name.split("__").pop() ?? name;
  if (!isRecord(input)) return short;
  const arg = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const key =
    arg("file_path") ?? arg("path") ?? arg("file") ?? arg("command") ?? arg("pattern") ?? arg("url") ?? arg("query");
  return key ? `${short} ${key}` : short;
}

/**
 * The first non-empty line of a tool result (truncated) plus its byte
 * count. The full output lives behind the collapsed Details disclosure.
 */
export function toolResultSummary(output: string): { line: string; bytes: number } {
  const bytes = new TextEncoder().encode(output).length;
  const raw = output.split("\n").find((line) => line.trim() !== "") ?? "";
  const line = raw.length > TOOL_SUMMARY_LIMIT ? `${raw.slice(0, TOOL_SUMMARY_LIMIT)}…` : raw;
  return { line, bytes };
}

/** Whether a tool result has content beyond the one-line summary. */
function toolResultHasMore(output: string): boolean {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  if (lines.length > 1) return true;
  return lines.length === 1 && lines[0].length > TOOL_SUMMARY_LIMIT;
}

/** Human labels for internal stream kinds — never render the raw kind. */
const INTERNAL_KIND_LABELS: Record<string, string> = {
  "route.decision": "routing decision",
  "llm.call": "model call",
};

const VIEW_TABS = [
  { view: "desktop", label: "Desktop", Icon: MonitorPlay },
  { view: "terminal", label: "Terminal", Icon: Terminal },
  { view: "browser", label: "Browser", Icon: Globe },
  { view: "files", label: "Files", Icon: FileText },
] as const;

const VM_STATUS_STYLES: Record<
  VmDisplayState,
  { pill: string; dot: string }
> = {
  starting: {
    pill: "border-amber-400/30 bg-amber-500/15 text-amber-300",
    dot: "bg-amber-400 animate-pulse",
  },
  ready: {
    pill: "border-emerald-400/30 bg-emerald-500/15 text-emerald-300",
    dot: "bg-emerald-400",
  },
  hibernated: {
    pill: "border-zinc-400/30 bg-zinc-500/15 text-zinc-300",
    dot: "bg-zinc-400",
  },
  error: {
    pill: "border-rose-400/30 bg-rose-500/15 text-rose-300",
    dot: "bg-rose-400",
  },
} as const;

/**
 * SSE events carry their fields at the top level (e.g. `{type, text}`); a few
 * control-plane events wrap them under `data`. Flatten both shapes so the same
 * renderer handles either.
 */
function eventPayload(item: RunStreamItem): Record<string, unknown> {
  if (item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
    const event = item.data as Record<string, unknown>;
    const nested = event.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return { ...(nested as Record<string, unknown>), ...event };
    }
    return event;
  }
  return {};
}

/** One stream event in the terminal. Exported for the static-render tests. */
export function StreamRow({ item }: { item: RunStreamItem }) {
  const payload = eventPayload(item);
  switch (item.kind) {
    case "shell.cmd": {
      const d = payload as { command?: string };
      const text = typeof d.command === "string" ? d.command : "";
      return (
        <div className="flex gap-2">
          <span className="text-emerald-400/80 select-none shrink-0">$</span>
          <span className="text-white/90 whitespace-pre-wrap break-words min-w-0">
            <AnsiRenderer text={text} />
          </span>
        </div>
      );
    }
    case "shell.output": {
      const d = payload as { stream?: string; text?: string };
      const isErr = d.stream === "stderr";
      const text = typeof d.text === "string" ? d.text : "";
      return (
        <div
          className={`whitespace-pre-wrap break-words min-w-0 ${
            isErr ? "text-rose-300/90" : "text-white/75"
          }`}
        >
          <AnsiRenderer text={text} />
        </div>
      );
    }
    case "run.created": {
      const d = payload as { prompt?: string };
      const text = typeof d.prompt === "string" ? d.prompt : "";
      return <SystemLine text={`task created · ${text}`} tone="muted" />;
    }
    case "run.queued": {
      // A queued prompt is a lifecycle line ("Queued · position 1") — never
      // the raw event JSON, which carries the internal userId.
      return <SystemLine text={lifecycleEventLine(item.kind, payload) ?? "Queued"} tone="muted" />;
    }
    case "assistant.text": {
      const text =
        typeof item.data === "string"
          ? item.data
          : typeof payload.text === "string"
            ? payload.text
            : String(payload.text ?? "");
      return (
        <div className="flex gap-2">
          <span className="text-indigo-300/80 select-none shrink-0">ai</span>
          <span className="text-white/85 whitespace-pre-wrap break-words min-w-0">
            <AnsiRenderer text={text} />
          </span>
        </div>
      );
    }
    case "tool.call": {
      const d = payload as { name?: string; input?: unknown; id?: string };
      const summary = toolCallSummary(d.name ?? "tool", d.input);
      const hasInput = d.input !== undefined && d.input !== null;
      return (
        <div className="min-w-0">
          <div className="flex gap-2">
            <span className="text-amber-400/80 select-none shrink-0">$</span>
            <span className="text-amber-200/90 whitespace-pre-wrap break-words min-w-0">{summary}</span>
          </div>
          {hasInput && (
            <details className="ml-4">
              <summary className="cursor-pointer text-[11px] text-white/35 select-none">Details</summary>
              <pre className="whitespace-pre-wrap break-words text-[11px] text-white/50">
                {JSON.stringify(redactEventData(payload), null, 2)}
              </pre>
            </details>
          )}
        </div>
      );
    }
    case "tool.result": {
      const d = payload as { ok?: boolean; output?: string; truncated?: boolean };
      const ok = d.ok !== false;
      const output = typeof d.output === "string" ? d.output : "";
      const { line, bytes } = toolResultSummary(output);
      const hasMore = toolResultHasMore(output);
      return (
        <div className="min-w-0">
          <div className="flex gap-2">
            <span className={`select-none shrink-0 ${ok ? "text-emerald-400/70" : "text-rose-400/70"}`}>
              {ok ? "ok" : "err"}
            </span>
            <span
              className={`whitespace-pre-wrap break-words min-w-0 ${ok ? "text-white/80" : "text-rose-300/90"}`}
            >
              <AnsiRenderer text={line} />
              {bytes > 0 && <span className="text-white/35"> · {bytes} B</span>}
            </span>
          </div>
          {hasMore && (
            <details className="ml-4">
              <summary className="cursor-pointer text-[11px] text-white/35 select-none">Details</summary>
              <pre className="whitespace-pre-wrap break-words text-[11px] text-white/50">
                <AnsiRenderer text={output} />
              </pre>
            </details>
          )}
        </div>
      );
    }
    case "usage": {
      const d = payload as { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
      const inT = d.inputTokens;
      const outT = d.outputTokens;
      const cached = d.cachedTokens;
      // A provider that reported no usage yields an event with no token
      // fields: show "—" rather than fabricating zeros.
      if (inT === undefined && outT === undefined) {
        return (
          <div className="flex gap-2">
            <span className="text-white/25 select-none shrink-0">tokens</span>
            <span className="text-white/40">—</span>
          </div>
        );
      }
      const inLabel = inT !== undefined ? inT.toLocaleString() : "—";
      const outLabel = outT !== undefined ? outT.toLocaleString() : "—";
      return (
        <div className="flex gap-2">
          <span className="text-white/25 select-none shrink-0">tokens</span>
          <span className="text-white/40">↑{inLabel} ↓{outLabel}{cached !== undefined && cached > 0 ? ` (${cached.toLocaleString()} cached)` : ""}</span>
        </div>
      );
    }
    case "vm.starting": {
      return <SystemLine text="Starting a separate Linux computer for this run…" />;
    }
    case "vm.ready": {
      const d = item.data as { ms?: number; durationMs?: number } | null;
      const ms = d?.ms ?? d?.durationMs;
      return <SystemLine text={`Computer ready${ms != null ? ` · ${ms}ms` : ""}`} />;
    }
    case "vm.error": {
      const d = item.data as { message?: string } | null;
      return <SystemLine text={`Could not start the computer · ${d?.message ?? "unknown"}`} tone="error" />;
    }
    case "approval.required": {
      const raw = typeof payload.approval === "object" && payload.approval !== null ? (payload.approval as Record<string, unknown>) : {};
      const action = typeof raw.action === "string" ? raw.action : "";
      return <SystemLine text={`approval required${action ? ` · ${action}` : ""}`} tone="muted" />;
    }
    case "approval.resolved": {
      const d = payload as { id?: string; verdict?: string };
      return <SystemLine text={`approval resolved · ${d.verdict ?? "unknown"}`} />;
    }
    case "approval.timeout": {
      const d = payload as { tool?: string; action?: string };
      const detail = d.action || d.tool;
      return (
        <SystemLine
          text={`approval timed out · auto-denied${detail ? ` · ${detail}` : ""}`}
          tone="error"
        />
      );
    }
    case "run.started": {
      // No model string: the raw provider model id is internal vocabulary.
      return <SystemLine text="run started" />;
    }
    case "run.finished": {
      const d = payload as { exitCode?: number; costUsd?: number; durationMs?: number; numTurns?: number; truncated?: boolean };
      const parts = [`exit ${d.exitCode ?? 0}`];
      if (d.durationMs != null) parts.push(`${(d.durationMs / 1000).toFixed(1)}s`);
      if (d.costUsd != null) parts.push(`$${d.costUsd.toFixed(3)}`);
      if (d.numTurns != null) parts.push(`${d.numTurns} turns`);
      if (d.truncated) parts.push("output truncated");
      return <SystemLine text={`run finished · ${parts.join(" · ")}`} />;
    }
    case "run.error": {
      const d = payload as { message?: string };
      return <SystemLine text={`run error · ${d.message ?? "unknown"}`} tone="error" />;
    }
    case "run.cancelled": {
      const d = payload as { reason?: string };
      return <SystemLine text={`run cancelled${d.reason ? ` (${d.reason})` : ""}`} tone="error" />;
    }
    case "role.changed": {
      const d = payload as { from?: { id?: string; name?: string }; to?: { id?: string; name?: string }; reason?: string };
      const fromName = d.from?.name ?? d.from?.id ?? "unknown";
      const toName = d.to?.name ?? d.to?.id ?? "unknown";
      const reason = typeof d.reason === "string" && d.reason !== "" ? ` · ${d.reason}` : "";
      return <SystemLine text={`role switched · ${fromName} → ${toName}${reason}`} tone="muted" />;
    }
    case "codebase.context.injected": {
      const d = payload as { repoHash?: string; tokenEstimate?: number };
      const tokens = typeof d.tokenEstimate === "number" ? d.tokenEstimate : undefined;
      return (
        <SystemLine
          text={`codebase context injected · ${tokens !== undefined ? `${tokens} tokens` : "pack ready"}`}
          tone="muted"
        />
      );
    }
    case "codebase.context.skipped": {
      const d = payload as { reason?: string };
      return <SystemLine text={`codebase context skipped · ${d.reason ?? "unknown"}`} tone="muted" />;
    }
    default: {
      // Unknown event types never render the raw kind: internal kinds
      // (route.decision, llm.call) would leak implementation vocabulary,
      // and the raw payload carries internal identifiers (userId) that
      // must not appear in the terminal. No Details disclosure here.
      const line = lifecycleEventLine(item.kind, payload);
      if (line) return <SystemLine text={line} tone="muted" />;
      return <SystemLine text={INTERNAL_KIND_LABELS[item.kind] ?? "event"} tone="muted" />;
    }
  }
}

function SystemLine({ text, tone }: { text: string; tone?: "error" | "muted" }) {
  const cls =
    tone === "error" ? "text-rose-400/80" : tone === "muted" ? "text-white/35" : "text-white/50";
  return (
    <div className="flex gap-2">
      <span className="text-white/25 select-none shrink-0">system</span>
      <span className={`whitespace-pre-wrap break-words min-w-0 ${cls}`}>{text}</span>
    </div>
  );
}

/** Friendly empty state for the terminal when there are no events yet (t14r). */
function TerminalEmptyState({
  title,
  hint,
  mascotState = "idle",
}: {
  title: string;
  hint: string;
  mascotState?: "hello" | "idle" | "working" | "attention";
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
      <MascotSvg state={svgStateForRun(mascotState)} size={64} />
      <div className="text-xs font-medium text-white/50">{title}</div>
      <div className="max-w-xs text-[11px] leading-relaxed text-white/30">{hint}</div>
    </div>
  );
}

const STREAM_BADGE_CLASS: Record<RunStreamBadgeTone, string> = {
  connecting: "border-sky-400/40 bg-sky-500/15 text-sky-300",
  live: "border-emerald-400/40 bg-emerald-500/15 text-emerald-300",
  reconnecting: "border-amber-400/40 bg-amber-500/15 text-amber-300",
  ended: "border-white/20 bg-white/10 text-white/60",
  error: "border-rose-400/40 bg-rose-500/15 text-rose-300",
};

export function ComputerScreen({
  logs,
  runId,
  activeView,
  onToggleView,
  onResetVm,
  vmResetting,
  activeRoleName,
  onShellRunStarted = () => {},
  onStopRun,
  polledVmStatus,
  desktopMode = true,
  filesOpenPath,
  embedded = false,
}: ComputerScreenProps) {
  const stream = useRunStream(runId);
  const liveRun = Boolean(runId);
  const streamBadge = liveRun ? getRunStreamBadge(stream) : null;

  // Each run.finished bumps this token; the Files view watches it and re-reads
  // the workspace so files written during the run show up without a manual refresh.
  const filesRefreshToken = stream.items.reduce(
    (token, item) => (item.kind === "run.finished" ? item.seq : token),
    0,
  );

  // VM status pill: the run stream's vm.* updates (immediate while a
  // run is live) plus the polled VM state, which is the only signal that
  // sees idle hibernation. The mapping lives in lib/client/vmStatus.
  const latestVmError = [...stream.items]
    .reverse()
    .find((item) => item.kind === "vm.error");
  const vmErrorMessage =
    latestVmError && typeof latestVmError.data === "object" && latestVmError.data !== null
      ? (latestVmError.data as { message?: unknown }).message
      : undefined;
  const vmDisplay = resolveVmDisplayStatus({
    latestVmEvent: latestVmLifecycleEvent(stream.items),
    polledStatus: polledVmStatus,
    resetting: vmResetting,
    errorMessage: typeof vmErrorMessage === "string" ? vmErrorMessage : undefined,
  });
  const vmStatusStyle = VM_STATUS_STYLES[vmDisplay.state];

  // When this deployment runs with desktop mode off the desktop tab is
  // hidden and the screen keeps today's terminal/browser/files views. The
  // poll is optimistic (desktop true) until the server confirms otherwise.
  const showDesktop = desktopMode;
  const tabs = showDesktop ? VIEW_TABS : VIEW_TABS.filter((t) => t.view !== "desktop");
  const selectedView: ComputerView = showDesktop || activeView !== "desktop" ? activeView : "terminal";

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((tab) => tab.view === selectedView);
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = (current + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (current - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    onToggleView(tabs[next].view);
    tabRefs.current[next]?.focus();
  };

  // --- terminal input: shell runs + history ---
  const [shellRunId, setShellRunId] = useState<string>();
  const [runningShellRunId, setRunningShellRunId] = useState<string>();
  // Mirror the running run id in a ref so Ctrl-C can cancel even in the same
  // tick the POST response arrives (before React has re-rendered).
  const runningShellRunIdRef = useRef<string | undefined>(undefined);
  // A shell run streams independently of the agent run: when the runId
  // changes, the old stream unmounts and the new one connects from seq 0.
  const shellStream = useRunStream(shellRunId);
  const [input, setInput] = useState("");
  // Command history is per browser session (tab) and survives reloads, but
  // not a new session. The reducer caps it at 100 and handles Up/Down.
  const [rawHistory, setHistory] = useSessionPersisted<unknown>(
    "ac.terminalHistory",
    EMPTY_TERMINAL_HISTORY,
  );
  const historyState = sanitizeTerminalHistory(rawHistory);
  const [execBusy, setExecBusy] = useState(false);
  const [execError, setExecError] = useState<string>();
  const execAbortRef = useRef<AbortController | null>(null);

  // A terminal event ends the running shell run, so Ctrl-C stops being armed.
  useEffect(() => {
    const last = shellStream.items[shellStream.items.length - 1];
    if (
      last &&
      (last.kind === "run.finished" ||
        last.kind === "run.error" ||
        last.kind === "run.cancelled")
    ) {
      runningShellRunIdRef.current = undefined;
      setRunningShellRunId(undefined);
    }
  }, [shellStream.items]);

  const cancelShell = useCallback(async () => {
    const runId = runningShellRunIdRef.current;
    // Abort the POST if it is still in flight; the server sees the dropped
    // request and cancels the run it just created.
    execAbortRef.current?.abort();
    setExecBusy(false);
    setExecError(undefined);
    if (!runId) return;
    try {
      await fetch(`/api/runtime/vm/exec?runId=${encodeURIComponent(runId)}`, {
        method: "DELETE",
      });
    } catch {
      /* the run still ends locally when the stream closes */
    }
  }, []);

  const submitShell = useCallback(
    async (raw: string) => {
      const cmd = raw.trim();
      if (!cmd || execBusy) return;
      setExecBusy(true);
      setExecError(undefined);
      setHistory((h: unknown) =>
        terminalHistoryReducer(sanitizeTerminalHistory(h), { type: "remember", command: cmd }),
      );
      setInput("");
      const controller = new AbortController();
      execAbortRef.current = controller;
      try {
        const res = await fetch("/api/runtime/vm/exec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.runId) {
          const reason = data?.error ?? `exec failed (${res.status})`;
          setExecError(reason);
          return;
        }
        runningShellRunIdRef.current = String(data.runId);
        setShellRunId(String(data.runId));
        setRunningShellRunId(String(data.runId));
        onShellRunStarted(String(data.runId));
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setExecError("Could not reach the runtime.");
        }
      } finally {
        if (execAbortRef.current === controller) execAbortRef.current = null;
        setExecBusy(false);
      }
    },
    [execBusy, onShellRunStarted, setHistory],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "c") {
      if (execBusy || runningShellRunIdRef.current) {
        e.preventDefault();
        setInput("");
        void cancelShell();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = terminalHistoryReducer(historyState, { type: "up", draft: input });
      setHistory(next);
      setInput(terminalHistoryValue(next));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = terminalHistoryReducer(historyState, { type: "down" });
      setHistory(next);
      setInput(terminalHistoryValue(next));
    }
  };

  // Terminal auto-scroll (q5): stick to the bottom while output streams and
  // after the run ends, unless the user scrolled up to read older output.
  // The version bumps on every appended row from any of the three sources
  // (live run stream, shell stream, simulated logs).
  const terminalContentVersion =
    stream.items.length + shellStream.items.length + logs.length;
  const terminalScroll = useStickToBottom(terminalContentVersion);

  return (
    <div className={embedded
      ? "flex h-full w-full flex-col overflow-hidden bg-[#08080c]"
      : "w-full max-w-5xl mx-auto rounded-3xl bg-[#0d0d12] border border-white/15 shadow-[0_25px_70px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col mb-6 backdrop-blur-2xl"}>
      {/* 1. OS Window Titlebar — the ScreenFrame owns all chrome when embedded. */}
      {!embedded && (
      <div className="bg-[#14141c] border-b border-white/10 px-4 py-2.5 flex items-center justify-between gap-3 select-none">
        {/* Mac OS Style Window Dots + VM identity */}
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onResetVm}
              title="Reset / Wipe Linux Computer"
              className="w-3 h-3 rounded-full bg-rose-500 hover:bg-rose-600 transition-colors"
            />
            <div className="w-3 h-3 rounded-full bg-amber-500/80" />
            <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
          </div>
          <div className="ml-2 flex min-w-0 items-center gap-2">
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-mono ${vmStatusStyle.pill}`}
              title={vmDisplay.tooltip}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${vmStatusStyle.dot}`} />
              Computer
              <span className="uppercase tracking-[0.08em] opacity-80">{vmDisplay.label}</span>
            </span>
            <span className="hidden truncate text-[11px] font-mono text-white/40 md:inline">
              {activeRoleName}
            </span>
          </div>
        </div>

        {/* View Switcher Tabs — single pill group with roving arrow-key focus */}
        <div
          role="group"
          aria-label="Computer views"
          onKeyDown={onTabKeyDown}
          className="hidden sm:flex shrink-0 items-center gap-0.5 rounded-full border border-white/10 bg-black/60 p-0.5 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        >
          {tabs.map(({ view, label, Icon }, index) => {
            const active = selectedView === view;
            return (
              <button
                key={view}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                onClick={() => onToggleView(view)}
                aria-pressed={active}
                tabIndex={active ? 0 : -1}
                className={`relative flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-mono transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
                  active
                    ? "bg-indigo-500/20 text-white font-medium shadow-[0_0_14px_rgba(99,102,241,0.18)]"
                    : "text-white/45 hover:bg-white/5 hover:text-white/85"
                }`}
              >
                <Icon className="w-3 h-3" /> {label}
                {active && (
                  <span className="absolute inset-x-2 bottom-0.5 h-0.5 rounded-full bg-indigo-400" />
                )}
              </button>
            );
          })}
        </div>

        {/* Right-aligned cwd — truncates with the full path in a tooltip */}
        <div className="flex min-w-0 max-w-[150px] items-center justify-end text-[11px] font-mono text-white/40">
          <span className="truncate text-right" title="Your workspace">
            Your workspace
          </span>
          {streamBadge && (
            <span
              data-testid="stream-status-badge"
              className={`ml-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide ${STREAM_BADGE_CLASS[streamBadge.tone]}`}
              title={stream.error ? `Stream: ${streamBadge.label} (${stream.error})` : `Stream: ${streamBadge.label}`}
            >
              {streamBadge.label}
            </span>
          )}
        </div>
      </div>
      )}

      {/* 2. Computer Screen Main Display. The desktop view is the main
          screen: it gets the full frame height (no 500px cap) so the
          16:9 live viewer has room; the tool views keep a fixed height so
          the panel never shifts as terminal output arrives. */}
      <div
        className={`relative flex flex-col overflow-hidden bg-[#08080c] ${
          embedded ? "min-h-0 flex-1" : "aspect-[16/10]"
        }`}
      >
        {selectedView === "desktop" && (
          <DesktopView
            vmState={vmDisplay.state}
            vmResetting={vmResetting}
            runActive={liveRun}
            onStopRun={onStopRun}
          />
        )}

        {selectedView === "terminal" && (
          <div className="flex-1 flex flex-col min-h-0 relative">
            <div
              ref={terminalScroll.ref}
              onScroll={terminalScroll.onScroll}
              className="flex-1 p-4 font-mono text-xs overflow-y-auto space-y-1.5 scrollbar-thin"
            >
              {liveRun ? (
                <>
                  {/* Approvals replace the narration row under the screen;
                      they are not part of this terminal scroll. */}
                  {stream.status === "reconnecting" && (
                    <div className="text-amber-400/60">reconnecting to run stream…</div>
                  )}
                  {stream.items.length === 0 ? (
                    <TerminalEmptyState
                      title="Jimmy is warming up the terminal"
                      hint="Once the agent starts, its live terminal events will stream in here."
                      mascotState="working"
                    />
                  ) : (
                    stream.items.map((item) => <StreamRow key={item.seq} item={item} />)
                  )}
                </>
              ) : (
                <>
                  {logs.length === 0 ? (
                    <TerminalEmptyState
                      title="Jimmy is ready when you are"
                      hint="Run an agent or interact with the computer — terminal output will appear here."
                      mascotState="idle"
                    />
                  ) : (
                    logs.map((l, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="text-white/30 select-none">$</span>
                        <span style={{ color: `hsl(${l.hue} 85% 75%)` }}>[{l.agent}]</span>
                        <span className="text-white/80">{l.msg}</span>
                      </div>
                    ))
                  )}
                </>
              )}

              {/* Live shell session: the user's own commands and their output
                  stream in from the shell run (POST /api/runtime/vm/exec).
                  `run.created` is skipped — the `$` echo of the command is the
                  line the user actually sees. */}
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

            {/* Shown once the user scrolls up: jump back to the latest output
                and re-engage sticking to the bottom (q5). */}
            {!terminalScroll.stuck && (
              <button
                type="button"
                onClick={terminalScroll.jumpToLatest}
                className="absolute bottom-14 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-indigo-400/40 bg-[#14141c]/95 px-3 py-1.5 font-mono text-[11px] text-indigo-300 shadow-lg backdrop-blur transition hover:bg-indigo-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
              >
                <ArrowDown className="h-3 w-3" />
                Jump to latest
              </button>
            )}

            {/* Terminal input line with history (Up/Down) */}
            <form
              className="flex items-center gap-2 px-4 py-2.5 border-t border-white/10 bg-[#0a0a10]"
              onSubmit={(e) => {
                e.preventDefault();
                void submitShell(input);
              }}
            >
              <span className="text-emerald-400/80 font-mono text-xs select-none">$</span>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder={
                  execBusy || runningShellRunId
                    ? "running… (Ctrl-C to stop)"
                    : "type a command for your computer"
                }
                disabled={vmResetting}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="flex-1 bg-transparent border-none focus:outline-none placeholder:text-white/25 text-white/90 font-mono text-xs"
              />
              {(execBusy || runningShellRunId) && (
                <span className="text-[10px] font-mono text-white/35 select-none">
                  {runningShellRunId ? "Ctrl-C to stop" : "starting…"}
                </span>
              )}
            </form>
            {execError && (
              <div className="px-4 py-1.5 border-t border-rose-500/20 bg-rose-500/10 text-rose-300/90 font-mono text-[11px]">
                {execError}
              </div>
            )}
          </div>
        )}

        {selectedView === "browser" && (
          <BrowserView runId={liveRun ? runId : undefined} />
        )}

        {selectedView === "files" && (
          <FilesView refreshToken={filesRefreshToken} openPath={filesOpenPath} />
        )}
      </div>
    </div>
  );
}
