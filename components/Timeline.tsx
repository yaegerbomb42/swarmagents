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
              <div className="label">Input</div>
              <pre>{inputText}</pre>
            </>
          )}
          {e.name === "bash" && <pre style={{ color: "var(--muted)" }}>$ {argSummary("bash", input, e.inputPreview)}</pre>}
          {(e.output || e.status === "running") && (
            <>
              <div className="label">Output</div>
              <pre className={e.status === "error" ? "err" : ""}>{e.output || "…"}</pre>
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
