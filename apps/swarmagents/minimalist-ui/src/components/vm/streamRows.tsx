"use client";

/**
 * TerminalView — the terminal, as a craft object rather than a log widget.
 *
 * The treatment that makes it read as *swarmagents* rather than a generic
 * shell: a prompt header that names the session (`$ swarm · live agent
 * session`), an emerald prompt gutter, a presence wash on the newest line the
 * agent wrote (a 900ms fade, never a layout change), and an input row whose
 * frame is the terminal's own emerald hairline. The shared chrome above and
 * the status bar below stay graphite — the emerald is content, not chrome.
 *
 * Performance is the other half of the brief: a run can stream thousands of
 * events and the user must still be able to type. The rows are keyed by seq
 * and appended (React reconciles by key, so old rows are not rebuilt), the
 * input is a plain controlled input outside the stream list, and the only
 * work a new event triggers is one appended row plus the scroll helper. The
 * view is hidden — not unmounted — when another tab is selected, so switching
 * tabs never replays it.
 */

import React from "react";
import { ArrowDown, Square } from "lucide-react";
import { AnsiRenderer } from "../../../../components/AnsiRenderer";
import { useStickToBottom } from "../../../../lib/client/useStickToBottom";
import { lifecycleEventLine, redactEventData } from "../../../../lib/client/runTimeline";
import type { RunStreamItem, RunStreamState } from "../../../../lib/client/useRunStream";
import type { LogEvent } from "../../engine";
import type { Presence } from "../../../../lib/client/presence";
import { cn } from "../../utils/cn";

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

/**
 * One stream event in the terminal. Exported for the static-render tests.
 * `live` marks the newest row: it gets the presence wash (a 900ms fade of the
 * view accent behind the line) so the terminal shows *where the agent is*
 * without moving, scrolling or stealing focus.
 */
export function StreamRow({ item, live = false }: { item: RunStreamItem; live?: boolean }) {
  const payload = eventPayload(item);
  const liveClass = live ? "sa-presence-row" : undefined;
  switch (item.kind) {
    case "shell.cmd": {
      const d = payload as { command?: string };
      const text = typeof d.command === "string" ? d.command : "";
      return (
        <div className={cn("flex gap-2", liveClass)}>
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
    case "log": {
      // Harness log lines (e.g. the Oracle gate's "oracle: 1/2 candidates
      // rejected" summary) render as muted system text, never raw JSON.
      const text = typeof payload.data === "string" ? payload.data : "";
      return <SystemLine text={text} tone="muted" />;
    }
    case "assistant.text": {
      const text =
        typeof item.data === "string"
          ? item.data
          : typeof payload.text === "string"
            ? payload.text
            : String(payload.text ?? "");
      return (
        <div className={cn("flex gap-2", liveClass)}>
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
        <div className={cn("min-w-0", liveClass)}>
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
      const d = payload as { provider?: string; model?: string };
      const parts = [d.provider, d.model].filter((value): value is string => typeof value === "string" && value !== "");
      return <SystemLine text={parts.length > 0 ? `run started · ${parts.join(" · ")}` : "run started"} />;
    }
    case "provider.pool": {
      const d = payload as { type?: string; provider?: string; model?: string; reason?: string };
      if (d.type === "pool.attempt" && d.reason === "failover") {
        const parts = [d.provider, d.model].filter((value): value is string => typeof value === "string" && value !== "");
        const label = parts.length > 0 ? parts.join(" · ") : "failover";
        return <SystemLine text={`→ ${label} (failover)`} tone="muted" />;
      }
      if (d.type === "pool.failover") {
        return <SystemLine text="failover" tone="muted" />;
      }
      if (d.type === "pool.family") {
        const parts = [d.model].filter((value): value is string => typeof value === "string" && value !== "");
        return <SystemLine text={parts.length > 0 ? `switched model · ${parts.join(" · ")}` : "switched model family"} tone="muted" />;
      }
      return null;
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
