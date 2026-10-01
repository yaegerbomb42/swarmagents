"use client";
import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentEvent } from "@/lib/types";
import { IChevron, IFile } from "./icons";

type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const fmtDur = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

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

function Thinking({ e }: { e: Ev<"thinking"> }) {
  const live = !e.done;
  const [open, setOpen] = useState<boolean | null>(null);
  const now = useNow(live);
  const shown = open ?? live;
  const secs = Math.max(1, Math.round(((e.endTs ?? now) - e.ts) / 1000));
  return (
    <div className="ev thinking">
      <button className="head" onClick={() => setOpen(!shown)}>
        <Chevron open={shown} />
        <span className={live ? "shimmer" : ""}>{live ? "Thinking" : `Thought for ${secs}s`}</span>
      </button>
      {shown && e.text && <div className="body">{e.text}</div>}
    </div>
  );
}

const TOOL_LABEL: Record<string, string> = {
  bash: "Shell",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  search: "Search",
  web_search: "Web search",
  web_fetch: "Fetch",
  browser: "Browser",
  plan: "Plan",
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
    case "search":
      return [pick("pattern"), pick("glob"), pick("path")].filter(Boolean).join("  ");
    case "web_search":
      return pick("query");
    case "web_fetch":
      return pick("url");
    case "browser":
      return [pick("action"), pick("url") || pick("text") || pick("key") || (input?.index != null ? `#${input.index}` : "")].filter(Boolean).join(" ");
    case "plan":
      return "";
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

/** Parse "[checkpoint <id> path=<abs>]" markers out of tool output. */
function checkpoints(output: string): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  for (const m of output.matchAll(/\[checkpoint ([a-f0-9]+) path=([^\]]+)\]/g)) out.push({ id: m[1], path: m[2] });
  return out;
}

/** Split tool output into pre/diff/post around --- old / +++ new style sections. Returns null if no diff present. */
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

/** Tiny line diff: returns rows of [kind, text] where kind is " " | "-" | "+". */
function lineDiff(oldText: string, newText: string): [string, string][] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // Simple LCS on capped inputs so huge outputs stay fast.
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
    if (A[i] === B[j]) {
      rows.push([" ", A[i].slice(0, 300)]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push(["-", A[i++].slice(0, 300)]);
    else rows.push(["+", B[j++].slice(0, 300)]);
  }
  while (i < n && rows.length < 300) rows.push(["-", A[i++].slice(0, 300)]);
  while (j < m && rows.length < 300) rows.push(["+", B[j++].slice(0, 300)]);
  return rows;
}

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = lineDiff(oldText, newText);
  const adds = rows.filter((r) => r[0] === "+").length;
  const dels = rows.filter((r) => r[0] === "-").length;
  return (
    <div className="diff">
      <div className="label">
        Changes · <span className="add">+{adds}</span> <span className="del">−{dels}</span>
      </div>
      <pre className="diff-body">
        {rows.map(([k, t], idx) => (
          <div key={idx} className={k === "+" ? "add" : k === "-" ? "del" : "ctx"}>
            <span className="sign">{k}</span> {t}
          </div>
        ))}
      </pre>
    </div>
  );
}

function UndoButton({ checkpoint, path }: { checkpoint: string; path: string }) {
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
            body: JSON.stringify({ checkpoint }),
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

function Tool({ e, onImage }: { e: Ev<"tool">; onImage: (src: string) => void }) {
  const live = e.status === "running" || e.status === "streaming";
  const [open, setOpen] = useState<boolean | null>(null);
  const now = useNow(live);
  // Live and failed tools open by default; finished ones fold to one line (click to see everything).
  const shown = open ?? (live || e.status === "error" || !!e.images?.length);
  const input = (e.input ?? {}) as Record<string, unknown>;
  const hasInput = Object.keys(input).length > 0;
  const inputText = hasInput ? JSON.stringify(input, null, 2) : e.inputPreview || "";
  return (
    <div className="ev tool">
      <button className="head" onClick={() => setOpen(!shown)}>
        <span className={`status ${e.status}`} />
        <span className="name">{toolName(e.name)}</span>
        <span className="arg">{argSummary(e.name, input, e.inputPreview)}</span>
        <span className="dur">{e.status === "streaming" ? "writing…" : fmtDur((e.endTs ?? now) - e.ts)}</span>
        <Chevron open={shown} />
      </button>
      {shown && (
        <div className="io">
          {inputText && e.name !== "bash" && (
            <>
              {labelWithCopy("Input", inputText)}
              <pre>{inputText}</pre>
            </>
          )}
          {e.name === "bash" && <pre style={{ color: "var(--muted)" }}>$ {argSummary("bash", input, e.inputPreview)}</pre>}
          {(e.output || e.status === "running") && (
            <>
              {e.output ? labelWithCopy("Output", e.output) : <div className="label">Output</div>}
              {(() => {
                const d = e.output ? splitDiff(e.output) : null;
                const cps = e.output ? checkpoints(e.output) : [];
                if (!d)
                  return <pre className={e.status === "error" ? "err" : ""}>{e.output || "…"}</pre>;
                return (
                  <>
                    {d.head && <pre className="head-pre">{d.head}</pre>}
                    <Diff oldText={d.oldText} newText={d.newText} />
                    {!!cps.length && (
                      <div className="undo-row">
                        <UndoButton checkpoint={cps[0].id} path={cps[0].path} />
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
          {!!e.images?.length && (
            <div className="shots">
              {e.images.map((im, i) => {
                const src = `data:${im.mediaType};base64,${im.data}`;
                return <img key={i} src={src} alt="" onClick={() => onImage(src)} />;
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-btn"
      title={copied ? "Copied!" : "Copy output"}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 6.5 5 9.5 10 2.5" />
        </svg>
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

function Compaction({ e }: { e: Ev<"compaction"> }) {
  const [open, setOpen] = useState(false);
  const live = !e.done;
  return (
    <div className="ev compact">
      <button className="head" onClick={() => setOpen(!open)}>
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

export function PlanCard({ e }: { e: Ev<"plan"> }) {
  const done = e.items.filter((i) => i.status === "done").length;
  return (
    <div className="ev plan">
      <div className="ttl">
        Plan · {done}/{e.items.length}
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

export function Timeline({ events, onImage }: { events: AgentEvent[]; onImage: (s: string) => void }) {
  return (
    <>
      {events.map((e) => {
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
              <div key={e.id} className="ev">
                <Md text={e.text} streaming={!e.done} />
              </div>
            ) : null;
          case "tool":
            return <Tool key={e.id} e={e} onImage={onImage} />;
          case "compaction":
            return <Compaction key={e.id} e={e} />;
          case "plan":
            return <PlanCard key={e.id} e={e} />;
          case "notice":
            return (
              <div key={e.id} className={`ev notice ${e.level}`}>
                {e.text}
              </div>
            );
          case "turn":
            return (
              <div key={e.id} className="turn" title={`stop: ${e.stop}`}>
                {e.provider} · {e.model} · {fmtK(e.inputTokens)} in{e.cachedTokens ? ` (${fmtK(e.cachedTokens)} cached)` : ""} · {fmtK(e.outputTokens)} out
              </div>
            );
        }
      })}
    </>
  );
}

export { fmtK };
