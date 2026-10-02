"use client";
import { memo, useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentEvent } from "@/lib/types";
import { IChevron, IFile } from "./icons";
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function Chevron({ open }: { open: boolean }) {
  return (
    <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
      <IChevron />
    </span>
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
        {live && <span className="dur" style={{ marginLeft: "auto", fontSize: "11.5px", color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>{fmtDur(now - e.ts)}</span>}
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
    return m ? m[1].replace(/\\n/g, " ").replace(/\\"/g, '"') : "";
  };
  switch (name) {
    case "bash":
      return pick("command");
    case "read_file":
    case "write_file":
    case "edit_file":
      return pick("path");
    case "restore_checkpoint":
      return pick("checkpoint") ? `checkpoint ${pick("checkpoint")}` : "";
    case "search":
      return [pick("pattern"), pick("glob"), pick("path")].filter(Boolean).join("  ");
    case "web_search":
      return pick("query");
    case "web_fetch":
      return pick("url");
    case "browser": {
      const action = pick("action");
      const url = pick("url");
      const idx = input?.index != null ? `#${input.index}` : "";
      const sel = pick("selector");
      const text = (pick("text") || pick("key") || pick("value") || "").slice(0, 60);
      const tab = input?.tab != null ? `tab ${input.tab}` : "";
      return [action, url || idx || sel || (sel ? "" : text ? `"${text}"` : "") || tab].filter(Boolean).join(" ");
    }
    case "plan":
      return "";
    case "api_request":
      return [pick("method"), pick("url")].filter(Boolean).join(" ");
    default: {
      const first = Object.values(input ?? {}).find((v) => typeof v === "string");
      return first ? String(first) : preview?.slice(0, 120) ?? "";
    }
  }
}

function toolName(name: string) {
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    return `${server} · ${tool}`;
  }
  return TOOL_LABEL[name] ?? name;
}

// ═══════ Diff rendering ═══════

function checkpoints(output: string): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  for (const m of output.matchAll(/\[checkpoint ([a-f0-9]+) path=([^\]]+)\]/g)) out.push({ id: m[1], path: m[2] });
  return out;
}

function splitDiff(output: string): { head: string; oldText: string; newText: string; tail: string } | null {
  const lines = output.split("\n");
  const oldIdx = lines.findIndex((l) => l.trim() === "--- old" || l.startsWith("--- before"));
  if (oldIdx < 0) return null;
  const plusIdx = lines.findIndex((l, i) => i > oldIdx && (l.trim() === "+++ new" || l.startsWith("+++ after")));
  if (plusIdx < 0) return null;
  return {
    head: lines.slice(0, oldIdx).filter((l) => !l.startsWith("[checkpoint ")).join("\n").trim(),
    oldText: lines.slice(oldIdx + 1, plusIdx).join("\n"),
    newText: lines.slice(plusIdx + 1).join("\n"),
    tail: "",
  };
}

function lineDiff(oldText: string, newText: string): [string, string][] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const A = a.slice(0, 400);
  const B = b.slice(0, 400);
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: [string, string][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m && rows.length < 300) {
    if (A[i] === B[j]) { rows.push([" ", A[i].slice(0, 300)]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push(["-", A[i++].slice(0, 300)]);
    else rows.push(["+", B[j++].slice(0, 300)]);
  }
  while (i < n && rows.length < 300) rows.push(["-", A[i++].slice(0, 300)]);
  while (j < m && rows.length < 300) rows.push(["+", B[j++].slice(0, 300)]);
  return rows;
}

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const [expanded, setExpanded] = useState(false);
  const rows = lineDiff(oldText, newText);
  const adds = rows.filter((r) => r[0] === "+").length;
  const dels = rows.filter((r) => r[0] === "-").length;
  if (adds === 0 && dels === 0) return null;
  const hidden = !expanded && rows.length > 40;
  const visible = hidden
    ? rows.filter(([k], idx) => k !== " " || rows.slice(Math.max(0, idx - 2), idx + 3).some(([k2]) => k2 !== " "))
    : rows;
  return (
    <div className="diff">
      <button className="diff-toggle" onClick={(e) => (e.stopPropagation(), setExpanded(!expanded))} title={expanded ? "Collapse" : "Show full diff"}>
        <span className="label">
          Changes · <span className="add">+{adds}</span> <span className="del">−{dels}</span>
        </span>
        {rows.length > 40 && <span className="diff-expand">{expanded ? "Show less" : `Show all ${rows.length} lines`}</span>}
      </button>
      <pre className="diff-body">
        {visible.map(([k, t], idx) => (
          <div key={idx} className={k === "+" ? "add" : k === "-" ? "del" : "ctx"}>
            <span className="sign">{k}</span> {t}
          </div>
        ))}
      </pre>
    </div>
  );
}

function UndoButton({ checkpoint, path, session }: { checkpoint: string; path: string; session?: string }) {
  const [state, setState] = useState<"idle" | "doing" | "done" | "error">("idle");
  if (state === "done") return <span className="undo done">✓ Restored</span>;
  return (
    <button
      className="undo"
      disabled={state === "doing"}
      title={`Restore ${path} to before this edit`}
      onClick={async (e) => {
        e.stopPropagation();
        setState("doing");
        try {
          const r = await fetch("/api/checkpoints/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ checkpoint, session }),
          });
          setState(r.ok ? "done" : "error");
          if (!r.ok) setTimeout(() => setState("idle"), 2500);
        } catch {
          setState("error");
          setTimeout(() => setState("idle"), 2500);
        }
      }}
    >
      {state === "doing" ? "Restoring…" : state === "error" ? "Failed — retry?" : "Undo this edit"}
    </button>
  );
}

// ═══════ Tool Card ═══════

function Tool({ e, onImage, session }: { e: Ev<"tool">; onImage: (src: string) => void; session?: string }) {
  const live = e.status === "running" || e.status === "streaming";
  const [open, setOpen] = useState<boolean | null>(null);
  const now = useNow(live);
  // Browser steps are the ones a user wants to see unfold, so their window card opens by default.
  const shown = open ?? (live || e.status === "error" || !!e.images?.length || e.name === "browser");
  const input = (e.input ?? {}) as Record<string, unknown>;
  const hasInput = Object.keys(input).length > 0;
  const inputText = hasInput ? JSON.stringify(input, null, 2) : e.inputPreview || "";
  const useAnsi = e.name === "bash" && e.output && hasAnsi(e.output);
  const previewPaths = (() => {
    if (!e.output) return [];
    if (e.name === "write_file" || e.name === "edit_file") return typeof input.path === "string" ? [input.path] : [];
    return producedFiles(e.output).slice(0, 4);
  })();
  const accent = toolAccent(e.name);

  return (
    <div className={`ev ev-virtual tool ${accent}${live ? " is-active" : ""}`}>
      <button className="head" onClick={() => setOpen(!shown)}>
        <StepIcon type="tool" name={e.name} />
        <span className={`status ${e.status}`} />
        <span className="name">{toolName(e.name)}</span>
        <span className="arg">{argSummary(e.name, input, e.inputPreview)}</span>
        <span className="dur">{e.status === "streaming" ? "writing…" : fmtDur((e.endTs ?? now) - e.ts)}</span>
        <Chevron open={shown} />
      </button>
      {shown && (
        <div className="io">
          {inputText && e.name !== "bash" && e.name !== "browser" && (
            <>
              {labelWithCopy("Input", inputText)}
              <pre>{inputText}</pre>
            </>
          )}
          {e.name === "bash" && <pre style={{ color: "var(--muted)" }}>$ {argSummary("bash", input, e.inputPreview)}</pre>}
          {(e.output || e.status === "running") && e.name !== "browser" && (
            <>
              {e.output ? labelWithCopy("Output", e.output) : <div className="label">Output</div>}
              {(() => {
                const d = e.output ? splitDiff(e.output) : null;
                const cps = e.output ? checkpoints(e.output) : [];
                if (!d) {
                  return (
                    <pre className={e.status === "error" ? "err" : ""}>
                      {useAnsi ? <AnsiRenderer text={e.output!} /> : (e.output || "…")}
                    </pre>
                  );
                }
                return (
                  <>
                    {d.head && <pre className="head-pre">{d.head}</pre>}
                    <Diff oldText={d.oldText} newText={d.newText} />
                    {!!cps.length && (
                      <div className="undo-row">
                        <UndoButton checkpoint={cps[0].id} path={cps[0].path} session={session} />
                        <span className="undo-hint" title={cps[0].path}>
                          Restores {cps[0].path.split("/").slice(-2).join("/")}
                        </span>
                      </div>
                    )}
                  </>
                );
              })()}
            </>
          )}
          {/* Browser actions get the browser-window card (address bar, set-of-marks shot, events). */}
          {e.name === "browser" && (
            <BrowserView input={input} output={e.output} images={e.images} status={e.status} onImage={onImage} />
          )}
          {!!e.images?.length && e.name !== "browser" && (
            <div className="shots">
              {e.images.map((im, i) => {
                const src = `data:${im.mediaType};base64,${im.data}`;
                return <img key={i} src={src} alt="" onClick={() => onImage(src)} />;
              })}
            </div>
          )}
          {!!session && !!previewPaths.length && (
            <div className="chips preview-chips">
              {previewPaths.map((p) => (
                <PreviewChip key={p} session={session} path={p} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════ Copy Button ═══════

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-btn"
      title={copied ? "Copied!" : "Copy output"}
      onClick={async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
      }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 6.5 5 9.5 10 2.5" /></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="4" y="4" width="7" height="7" rx="1.5" />
          <path d="M8 4V2.5A1.5 1.5 0 0 0 6.5 1H2.5A1.5 1.5 0 0 0 1 2.5v4A1.5 1.5 0 0 0 2.5 8H4" />
        </svg>
      )}
    </button>
  );
}

function labelWithCopy(label: string, text: string) {
  return (
    <div className="label-row">
      <span className="label">{label}</span>
      <CopyButton text={text} />
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
        <span style={{ marginLeft: "auto", color: "var(--faint)", fontSize: 12 }}>{e.reason}</span>
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
        <span style={{ marginLeft: 6 }}>Plan · {done}/{e.items.length}</span>
      </div>
      <ul>
        {e.items.map((it, i) => (
          <li key={i} className={it.status}>
            <span className={`box ${it.status}`}>{it.status === "done" && <svg width="8" height="8" viewBox="0 0 10 10"><path d="M1.5 5.2 4 7.5 8.5 2.5" stroke="#fff" strokeWidth="1.8" fill="none" /></svg>}</span>
            {it.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ═══════ Step Grouping ═══════

interface StepGroup {
  kind: "group";
  name: string;
  events: Ev<"tool">[];
  totalDur: number;
}
type TimelineItem = { kind: "single"; event: AgentEvent } | StepGroup;

/** Group consecutive tool calls of the same name (read_file, read_file, ... → "Read 5 files") */
function groupEvents(events: AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    // Only group settled (ok) tool calls of the same name, minimum 3
    if (e.type === "tool" && e.status === "ok") {
      let j = i + 1;
      while (j < events.length && events[j].type === "tool" && (events[j] as Ev<"tool">).name === e.name && (events[j] as Ev<"tool">).status === "ok") j++;
      if (j - i >= 3) {
        const group = events.slice(i, j) as Ev<"tool">[];
        const totalDur = group.reduce((sum, g) => sum + ((g.endTs ?? g.ts) - g.ts), 0);
        items.push({ kind: "group", name: e.name, events: group, totalDur });
        i = j;
        continue;
      }
    }
    items.push({ kind: "single", event: events[i] });
    i++;
  }
  return items;
}

function GroupCard({ group, onImage, session }: { group: StepGroup; onImage: (s: string) => void; session?: string }) {
  const [open, setOpen] = useState(false);
  const label = toolName(group.name);
  const count = group.events.length;
  // Summarize: for file tools, show file count; for bash, show command count
  const summary = group.name === "read_file" ? `${count} files`
    : group.name === "bash" ? `${count} commands`
    : `${count} calls`;

  return (
    <div className="step-group ev-virtual">
      <button className="step-group-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <StepIcon type="tool" name={group.name} />
        <Chevron open={open} />
        <span className="step-group-count">{label}</span>
        <span style={{ color: "var(--muted)" }}>{summary}</span>
        <span className="step-group-dur">{fmtDur(group.totalDur)}</span>
      </button>
      {open && (
        <div className="step-group-items">
          {group.events.map((e) => (
            <Tool key={e.id} e={e} onImage={onImage} session={session} />
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
    <>
      {items.map((item) => {
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
