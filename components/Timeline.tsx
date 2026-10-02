"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentEvent } from "@/lib/types";
import { IChevron, IFile, ICopy, ICheck, IX } from "./icons";
import { stepIcon, toolAccent } from "./StepIcons";
import { AnsiRenderer, hasAnsi } from "./AnsiRenderer";
import { PreviewChip, producedFiles } from "./FilePreview";
import { BrowserView } from "./BrowserView";
import "./timeline.css";

type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const fmtDur = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

// ═══════ Shared helpers ═══════

const Md = memo(function Md({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`md${streaming ? " caret" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: (p) => <a {...p} target="_blank" rel="noreferrer" />,
        code: (p) => {
          const { children, ...props } = p;
          const childStr = typeof children === "string" ? children : "";
          const inline = !childStr.includes("\n");
          if (inline) return <code {...props}>{children}</code>;
          return <pre><code {...props}>{children}</code></pre>;
        },
        pre: (p) => <div className="code-block"><pre {...p} /></div>,
      }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function Chevron({ open }: { open: boolean }) {
  return (
    <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : "none", transition: "transform 150ms cubic-bezier(0.16, 1, 0.3, 1)" }}>
      <IChevron />
    </span>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      className="copy-btn"
      onClick={copy}
      aria-label={copied ? "Copied!" : label}
      title={copied ? "Copied!" : label}
    >
      {copied ? <ICheck size={12} /> : <ICopy size={12} />}
    </button>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StepIcon({ type, name, level }: { type: string; name?: string; level?: string }) {
  const Icon = stepIcon(type, name, level);
  return <span className="step-icon"><Icon /></span>;
}

// ═══════ Thinking ═══════

function Thinking({ e }: { e: Ev<"thinking"> }) {
  const live = !e.done;
  const [open, setOpen] = useState<boolean | null>(null);
  const now = useNow(live);
  const shown = open ?? live;
  const secs = Math.max(1, Math.round(((e.endTs ?? now) - e.ts) / 1000));
  return (
    <div className="ev ev-virtual thinking">
      <button className="head" onClick={() => setOpen(!shown)}>
        <StepIcon type="thinking" />
        <Chevron open={shown} />
        <span className={live ? "shimmer" : ""}>{live ? "Thinking" : `Thought for ${secs}s`}</span>
        {live && <span className="dur" style={{ marginLeft: "auto", fontSize: "11.5px", color: "var(--color-text-faint)", fontVariantNumeric: "tabular-nums" }}>{fmtDur(now - e.ts)}</span>}
      </button>
      {shown && e.text && <div className="body">{e.text}</div>}
    </div>
  );
}

// ═══════ Tool labels and summaries ═══════

const TOOL_LABEL: Record<string, string> = {
  bash: "Shell",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  restore_checkpoint: "Undo",
  search: "Search",
  web_search: "Web search",
  web_fetch: "Fetch",
  browser: "Browser",
  plan: "Plan",
  api_request: "API",
  subagent: "Sub-agent",
};

function argSummary(name: string, input: Record<string, unknown>, preview?: string): string {
  const pick = (k: string) => {
    if (input?.[k] != null) return String(input[k]);
    const m = preview?.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    return m ? m[1].replace(/\\n/g, " ").replace(/\\\"/g, '"') : "";
  };
  switch (name) {
    case "bash": return pick("command");
    case "read_file":
    case "write_file":
    case "edit_file": return pick("path");
    case "restore_checkpoint": return pick("checkpoint") ? `checkpoint ${pick("checkpoint")}` : "";
    case "search": return [pick("pattern"), pick("glob"), pick("path")].filter(Boolean).join("  ");
    case "web_search": return pick("query");
    case "web_fetch": return pick("url");
    case "browser": {
      const action = pick("action");
      const url = pick("url");
      const idx = input?.index != null ? `#${input.index}` : "";
      const sel = pick("selector");
      const text = (pick("text") || pick("key") || pick("value") || "").slice(0, 40);
      return [action, url, idx, sel, text].filter(Boolean).join(" → ");
    }
    case "plan": return "";
    case "api_request": return pick("method") ? `${pick("method")} ${pick("url")}` : pick("url") ?? "";
    case "subagent": return pick("task")?.slice(0, 60) ?? "";
    default: return "";
  }
}

// ═══════ Tool ═══════

function Tool({ e, onImage, session }: { e: Ev<"tool">; onImage: (s: string) => void; session?: string }) {
  const name = e.name;
  const label = TOOL_LABEL[name] ?? name;
  const accentClass = toolAccent(name);
  const live = !e.done;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const now = useNow(live);
  const duration = live ? now - e.ts : (e.endTs ?? now) - e.ts;

  const copyOutput = async () => {
    const outputText = typeof e.output === "string" ? e.output : JSON.stringify(e.output, null, 2);
    await navigator.clipboard.writeText(outputText);
    setCopied("output");
    setTimeout(() => setCopied(null), 1500);
  };

  const copyInput = async () => {
    await navigator.clipboard.writeText(JSON.stringify(e.input, null, 2));
    setCopied("input");
    setTimeout(() => setCopied(null), 1500);
  };

  const isDiff = name === "edit_file" || name === "write_file";
  const showDiff = isDiff && e.output && typeof e.output === "object" && "diff" in e.output;

  return (
    <div className={`ev ev-virtual tool ${accentClass} ${live ? "is-active" : ""} ${open ? "open" : ""}`}>
      <button className="head" onClick={() => setOpen(!open)}>
        <StepIcon type={name} name={name} />
        <Chevron open={open || live} />
        <span className="tool-info">
          <span className="tool-name">{label}</span>
          <span className="tool-args">{argSummary(name, e.input as Record<string, unknown>, e.output as string)}</span>
        </span>
        <span className="tool-meta">
          {live && <span className="dur">{fmtDur(duration)}</span>}
          {!live && e.exitCode !== undefined && (
            <span className={`exit ${e.exitCode === 0 ? "ok" : "err"}`}>
              {e.exitCode === 0 ? <ICheck size={10} /> : <IX size={10} />} {e.exitCode}
            </span>
          )}
          {open && (
            <>
              <CopyButton text={JSON.stringify(e.input, null, 2)} label="Copy input" />
              {e.output && <CopyButton text={typeof e.output === "string" ? e.output : JSON.stringify(e.output, null, 2)} label="Copy output" />}
            </>
          )}
        </span>
      </button>
      {(open || live) && (
        <div className="body">
          {showDiff && (
            <div className="diff-view">
              <DiffView diff={(e.output as any).diff} />
            </div>
          )}
          {e.output && !showDiff && (
            <div className="tool-output">
              {hasAnsi(e.output as string) ? (
                <AnsiRenderer text={e.output as string} />
              ) : (
                <pre>{typeof e.output === "string" ? e.output : JSON.stringify(e.output, null, 2)}</pre>
              )}
            </div>
          )}
          {e.error && <div className="tool-error">{e.error}</div>}
        </div>
      )}
    </div>
  );
}

// ═══════ Diff View ═══════

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <div className="diff">
      {lines.map((line, i) => {
        if (line.startsWith("+")) return <div key={i} className="line add"><span className="marker">+</span>{line.slice(1)}</div>;
        if (line.startsWith("-")) return <div key={i} className="line remove"><span className="marker">-</span>{line.slice(1)}</div>;
        if (line.startsWith("@")) return <div key={i} className="line hunk">{line}</div>;
        return <div key={i} className="line context"><span className="marker"> </span>{line}</div>;
      })}
    </div>
  );
}

// ═══════ Compaction ═══════

function Compaction({ e }: { e: Ev<"compaction"> }) {
  const [open, setOpen] = useState(false);
  const live = !e.done;
  return (
    <div className="ev ev-virtual compact">
      <button className="head" onClick={() => setOpen(!open)}>
        <StepIcon type="compaction" />
        <Chevron open={open || live} />
        <span className={live ? "shimmer" : ""}>
          {live ? "Compacting context" : `Context compacted · ${fmtK(e.before)} → ${fmtK(e.after)} tokens`}
        </span>
        <span style={{ marginLeft: "auto", color: "var(--color-text-faint)", fontSize: "11.5px" }}>{e.reason}</span>
      </button>
      {(open || live) && e.summary && <div className="body">{e.summary}</div>}
    </div>
  );
}

// ═══════ Plan Card ═══════

export function PlanCard({ e }: { e: Ev<"plan"> }) {
  const done = e.items.filter((i) => i.status === "done").length;
  return (
    <div className="ev ev-virtual plan">
      <div className="ttl">
        <StepIcon type="plan" />
        Plan · {done}/{e.items.length}
      </div>
      <ul>
        {e.items.map((it, i) => (
          <li key={i} className={it.status}>
            <span className={`box ${it.status}`}>{it.status === "done" && <ICheck />}</span>
            {it.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ═══════ Grouping ═══════

function groupEvents(events: AgentEvent[]) {
  const items: Array<{ kind: "event"; event: AgentEvent } | { kind: "group"; events: AgentEvent[]; totalDur: number }> = [];
  let currentGroup: AgentEvent[] = [];
  let groupStart = 0;

  const flushGroup = () => {
    if (currentGroup.length > 1) {
      const totalDur = currentGroup.reduce((sum, ev) => sum + (ev.type === "tool" && ev.endTs ? ev.endTs - ev.ts : 0), 0);
      items.push({ kind: "group", events: currentGroup, totalDur });
    } else if (currentGroup.length === 1) {
      items.push({ kind: "event", event: currentGroup[0] });
    }
    currentGroup = [];
  };

  for (const e of events) {
    if (e.type === "tool") {
      currentGroup.push(e);
      if (!groupStart) groupStart = e.ts;
    } else {
      flushGroup();
      items.push({ kind: "event", event: e });
    }
  }
  flushGroup();
  return items;
}

function GroupCard({ group, onImage, session }: { group: { events: AgentEvent[]; totalDur: number }; onImage: (s: string) => void; session?: string }) {
  const [open, setOpen] = useState(false);
  const firstTool = group.events[0] as Ev<"tool">;
  const label = TOOL_LABEL[firstTool.name] ?? firstTool.name;
  const accentClass = toolAccent(firstTool.name);

  return (
    <div className="step-group">
      <button className="step-group-toggle" onClick={() => setOpen(!open)}>
        <StepIcon type={firstTool.name} name={firstTool.name} />
        <span className="step-group-count">{group.events.length} × {label}</span>
        <span className="step-group-dur">{fmtDur(group.totalDur)}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="step-group-items">
          {group.events.map((e) => (
            <Tool key={e.id} e={e as Ev<"tool">} onImage={onImage} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════ Load Earlier ═══════

export function LoadEarlier({ archivedCount, sessionId }: { archivedCount: number; sessionId: string }) {
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<AgentEvent[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/sessions/${sessionId}/events?limit=100`);
      if (r.ok) {
        const d = await r.json();
        setLoaded(d.events ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  if (archivedCount <= 0) return null;

  return (
    <button className="load-earlier" onClick={load} disabled={loading}>
      {loading ? "Loading…" : `Show ${archivedCount.toLocaleString()} earlier events`}
    </button>
  );
}

// ═══════ Main Timeline ═══════

export function Timeline({ events, onImage, session }: { events: AgentEvent[]; onImage: (s: string) => void; session?: string }) {
  const items = groupEvents(events);

  return (
    <>{
      items.map((item) => {
        if (item.kind === "group") {
          return <GroupCard key={`g-${item.events[0].id}`} group={item} onImage={onImage} session={session} />;
        }
        const e = item.event;
        if ((e as { hidden?: boolean }).hidden) return null;
        switch (e.type) {
          case "user":
            return (
              <div key={e.id} className="user">
                {!!e.attachments?.length && (
                  <div className="chips">
                    {e.attachments.map((a) => (
                      <span key={a.path} className="chip" title={a.path}>
                        <IFile />
                        <span>{a.name}</span>
                      </span>
                    ))}
                  </div>
                )}
                {e.text && <div className="bubble">{e.text}</div>}
              </div>
            );
          case "thinking":
            return <Thinking key={e.id} e={e} />;
          case "text":
            return e.text ? (
              <div key={e.id} className="ev ev-virtual">
                <Md text={e.text} streaming={!e.done} />
              </div>
            ) : null;
          case "tool":
            return <Tool key={e.id} e={e} onImage={onImage} session={session} />;
          case "compaction":
            return <Compaction key={e.id} e={e} />;
          case "plan":
            return <PlanCard key={e.id} e={e} />;
          case "notice":
            return (
              <div key={e.id} className={`ev ev-virtual notice ${e.level}`}>
                <StepIcon type="notice" level={e.level} />
                <span>{e.text}</span>
              </div>
            );
          case "turn":
            return (
              <div key={e.id} className="turn">
                {e.provider} · {e.model} · {fmtK(e.inputTokens)} in{e.cachedTokens ? ` (${fmtK(e.cachedTokens)} cached)` : ""} · {fmtK(e.outputTokens)} out
              </div>
            );
        }
      })}
    </>
  );
}

export { fmtK };
