"use client";

// AnsiRenderer: renders text containing ANSI SGR escape sequences (bash, logs)
// as inline-styled spans, and detects whether a string contains any escapes.
//
// `AnsiTerminal` (exported from this file as well) is the terminal-flavoured
// view built on the same ANSI parser. It lays log text out line by line,
// colours every line by the prefix it starts with (system dim, ai white, $
// tool amber, ok emerald, errors red), puts a small gutter (timestamp + kind
// rail) to the left of each line, stays pinned to the newest line while the
// user has not scrolled up — a floating "Jump to latest" button appears when
// it has — wraps long lines instead of scrolling sideways, and keeps the text
// selectable so it can be copied straight out of the terminal.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowDown } from "lucide-react";

/** True when `text` contains at least one ANSI SGR escape sequence. */
export function hasAnsi(text: string): boolean {
  const re = /\x1b\[[0-9;]*m/;
  re.lastIndex = 0;
  return re.test(text);
}

interface StyleState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  reverse?: boolean;
}

const FG = new Map<number, string>([
  [30, "#1e1e1e"],
  [31, "#d16969"],
  [32, "#89b482"],
  [33, "#d7ba7d"],
  [34, "#6cb6ff"],
  [35, "#c586c0"],
  [36, "#4ec9b0"],
  [37, "#d4d4d4"],
  [90, "#808080"],
  [91, "#f14c4c"],
  [92, "#6a9955"],
  [93, "#dcdcaa"],
  [94, "#569cd6"],
  [95, "#ce9178"],
  [96, "#9cdcfe"],
  [97, "#ffffff"],
]);

const BG = new Map<number, string>([
  [40, "#1e1e1e"],
  [41, "#d16969"],
  [42, "#89b482"],
  [43, "#d7ba7d"],
  [44, "#6cb6ff"],
  [45, "#c586c0"],
  [46, "#4ec9b0"],
  [47, "#d4d4d4"],
  [100, "#808080"],
  [101, "#f14c4c"],
  [102, "#6a9955"],
  [103, "#dcdcaa"],
  [104, "#569cd6"],
  [105, "#ce9178"],
  [106, "#9cdcfe"],
  [107, "#ffffff"],
]);

/** 256-color palette: 16 base + 6×6×6 cube + 24 grays. */
function ansi256(n: number): string {
  if (n < 16) return FG.get(FG.has(n) ? n : 37) ?? "#d4d4d4";
  if (n < 232) {
    const cube = n - 16;
    const r = Math.floor(cube / 36);
    const g = Math.floor((cube % 36) / 6);
    const b = cube % 6;
    const ch = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function applySgr(style: StyleState, params: string[]): StyleState {
  if (params.length === 0) return {};
  let i = 0;
  let next = { ...style };
  while (i < params.length) {
    const code = Number(params[i]);
    switch (code) {
      case 0:
        next = {};
        break;
      case 1:
        next.bold = true;
        break;
      case 2:
        next.dim = true;
        break;
      case 3:
        next.italic = true;
        break;
      case 4:
        next.underline = true;
        break;
      case 7:
        next.reverse = true;
        break;
      case 9:
        next.strike = true;
        break;
      case 22:
        next.bold = false;
        next.dim = false;
        break;
      case 23:
        next.italic = false;
        break;
      case 24:
        next.underline = false;
        break;
      case 27:
        next.reverse = false;
        break;
      case 29:
        next.strike = false;
        break;
      case 39:
        next.fg = undefined;
        break;
      case 49:
        next.bg = undefined;
        break;
      case 38:
      case 48: {
        const kind = code === 38 ? "fg" : "bg";
        const mode = Number(params[i + 1]);
        if (mode === 5) {
          next[kind] = ansi256(Number(params[i + 2]));
          i += 2;
        } else if (mode === 2) {
          next[kind] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
          i += 4;
        }
        break;
      }
      default:
        if (FG.has(code)) next.fg = FG.get(code);
        else if (BG.has(code)) next.bg = BG.get(code);
        break;
    }
    i += 1;
  }
  return next;
}

function toCss(style: StyleState): CSSProperties {
  const out: CSSProperties = {};
  if (style.fg) out.color = style.fg;
  if (style.bg) out.backgroundColor = style.bg;
  if (style.bold) out.fontWeight = 700;
  if (style.dim) out.opacity = 0.6;
  if (style.italic) out.fontStyle = "italic";
  if (style.underline) out.textDecoration = "underline";
  if (style.strike) out.textDecoration = "line-through";
  if (style.reverse) {
    out.color = style.bg ?? "#1e1e1e";
    out.backgroundColor = style.fg ?? "#d4d4d4";
  }
  return out;
}

function buildNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let style: StyleState = {};
  let last = 0;
  let key = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const seg = text.slice(last, m.index);
      nodes.push(
        <span key={key++} style={toCss(style)}>
          {seg}
        </span>,
      );
    }
    style = applySgr(style, m[1] ? m[1].split(";") : []);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(
      <span key={key++} style={toCss(style)}>
        {text.slice(last)}
      </span>,
    );
  }
  if (nodes.length === 0) nodes.push(<span key={0}>{text}</span>);
  return nodes;
}

/** Renders `text` with ANSI SGR colors/styles applied. */
export function AnsiRenderer({ text }: { text: string }) {
  const nodes = useMemo(() => buildNodes(text), [text]);
  return <>{nodes}</>;
}

/* -------------------------------------------------------------------------- */
/* Terminal log view                                                          */
/* -------------------------------------------------------------------------- */

/** Every ANSI SGR escape sequence. */
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** Removes ANSI SGR escapes so plain-text heuristics can run on the result. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_RE, "");
}

/** How a log line is styled, decided by the prefix it starts with. */
export type LogLineKind = "system" | "ai" | "tool" | "ok" | "error" | "output";

interface KindStyle {
  /** Colour of the message text. */
  text: string;
  /** Colour of the little rail in the left gutter. */
  rail: string;
}

const KIND_STYLES: Record<LogLineKind, KindStyle> = {
  system: { text: "text-white/40", rail: "bg-white/20" },
  ai: { text: "text-white/90", rail: "bg-cyan-400/60" },
  tool: { text: "text-amber-200/90", rail: "bg-amber-400/60" },
  ok: { text: "text-emerald-200/90", rail: "bg-emerald-400/60" },
  error: { text: "text-rose-300/90", rail: "bg-rose-400/60" },
  output: { text: "text-white/70", rail: "bg-white/15" },
};

/** A leading `HH:MM:SS` (optionally bracketed) moves to the gutter. */
const TIME_PREFIX_RE = /^\[?(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\]?[ \t]+/;

/** Decides which palette a log line uses, from the prefix it starts with. */
export function classifyLogLine(line: string): LogLineKind {
  const plain = stripAnsi(line).trimStart();
  // A leading timestamp is gutter material, never part of the prefix.
  const stamp = TIME_PREFIX_RE.exec(plain);
  const text = stamp ? plain.slice(stamp[0].length) : plain;
  if (/^system\b/i.test(text)) return "system";
  if (/^ai\b/i.test(text)) return "ai";
  if (/^\$(?:\s|$)/.test(text)) return "tool";
  if (/^ok\b/i.test(text)) return "ok";
  if (/^(?:err|error|fail(?:ed|ure)?)\b/i.test(text)) return "error";
  if (/^stderr\b/i.test(text)) return "error";
  return "output";
}

/**
 * Maps an index in the ANSI-stripped text back to the matching index in the
 * original text (escape sequences take up characters but no plain text).
 */
function plainIndexToRaw(raw: string, plainIndex: number): number {
  let seen = 0;
  let i = 0;
  while (i < raw.length && seen < plainIndex) {
    if (raw[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(raw.slice(i));
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    seen += 1;
    i += 1;
  }
  return i;
}

export interface LogLine {
  /** Style bucket derived from the line prefix. */
  kind: LogLineKind;
  /** Time of day taken from the gutter, when the line carried one. */
  timestamp?: string;
  /** The line itself, minus the timestamp that moved into the gutter. */
  body: string;
}

/** Splits a raw log line into its timestamp, prefix kind and body. */
export function parseLogLine(raw: string): LogLine {
  const plain = stripAnsi(raw);
  const match = TIME_PREFIX_RE.exec(plain);
  if (!match) {
    return { kind: classifyLogLine(raw), body: raw };
  }
  const cut = plainIndexToRaw(raw, match[0].length);
  const body = raw.slice(cut);
  return { kind: classifyLogLine(body), timestamp: match[1], body };
}

/** One terminal row: gutter (timestamp + rail) plus the message. */
function LogRow({ line }: { line: string }) {
  const { kind, timestamp, body } = useMemo(() => parseLogLine(line), [line]);
  const nodes = useMemo(() => buildNodes(body), [body]);
  const style = KIND_STYLES[kind];
  return (
    <div className="pl-[52px] text-[11.5px] leading-[1.55]">
      {/* The gutter hangs into the row padding so wrapped lines stay aligned
          under the message, and stays out of the copied selection. */}
      <span className="-ml-[52px] inline-block w-[52px] select-none align-top">
        <span className="inline-block w-[46px] text-right font-mono text-[9.5px] tabular-nums text-white/25">
          {timestamp ?? ""}
        </span>
        <span
          className={`ml-[4px] inline-block h-[9px] w-[2px] rounded-full align-middle ${style.rail}`}
        />
      </span>
      <span className={`whitespace-pre-wrap break-words ${style.text}`}>{nodes}</span>
    </div>
  );
}

export interface AnsiTerminalProps {
  /** Raw log text; may contain ANSI escapes and newlines. */
  text: string;
  /** Extra classes for the outer wrapper. */
  className?: string;
  /** Accessible name for the log region. */
  label?: string;
  /** Only the newest `maxLines` lines are kept (guards huge logs). */
  maxLines?: number;
}

/**
 * Scrollable terminal log: per-prefix line colours, a small left gutter, and
 * a tail that follows the newest line until the user scrolls up.
 */
export function AnsiTerminal({
  text,
  className,
  label = "Terminal output",
  maxLines = 1000,
}: AnsiTerminalProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pinned, setPinned] = useState(true);

  const lines = useMemo(() => {
    const all = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    return all.length > maxLines ? all.slice(all.length - maxLines) : all;
  }, [text, maxLines]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const syncPinned = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
    stickRef.current = atBottom;
    setPinned(atBottom);
  }, []);

  const onScroll = useCallback(() => {
    // While a jump is animating, ignore the intermediate scroll positions so
    // the button does not flicker back in mid-flight.
    if (jumpTimerRef.current) return;
    syncPinned();
  }, [syncPinned]);

  // Follow the tail as long as the user has not scrolled away from it.
  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Keep the tail pinned when the content itself resizes (wrapping, streaming
  // chunks, late-loading fonts).
  useEffect(() => {
    const target = contentRef.current ?? scrollerRef.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const el = scrollerRef.current;
      if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
    },
    [],
  );

  const jumpToLatest = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = true;
    setPinned(true);
    scrollToBottom("smooth");
    if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current = setTimeout(() => {
      jumpTimerRef.current = null;
      syncPinned();
    }, 500);
  }, [scrollToBottom, syncPinned]);

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${className ?? ""}`}>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label={label}
        data-testid="ansi-terminal"
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden font-mono"
      >
        <div ref={contentRef}>
          {lines.map((line, i) => (
            <LogRow key={i} line={line} />
          ))}
        </div>
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest"
          data-testid="jump-to-latest"
          className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-cyan-400/40 bg-[#0d0d12]/95 px-3 py-1.5 font-mono text-[11px] text-cyan-300 shadow-[0_8px_24px_rgba(0,0,0,0.65)] backdrop-blur transition-colors hover:border-cyan-300/70 hover:bg-cyan-400/15"
        >
          <ArrowDown className="h-3 w-3" />
          Jump to latest
        </button>
      )}
    </div>
  );
}

export default AnsiRenderer;
