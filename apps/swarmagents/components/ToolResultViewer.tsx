"use client";

// ToolResultViewer: collapsible rendering of a swarm tool call's payload.
//
// The whole point is to keep the swarm timeline from flooding. A tool's input is
// JSON, its result is usually stdout/stderr or a structured JSON payload — all of
// which can be arbitrarily large. Every section is a collapsible block that opens
// by default only when small, and shows a one-line-ish preview otherwise:
//   - JSON inputs / payloads are pretty-printed and detected automatically,
//   - stdout and stderr are split into their own blocks (stderr styled as errors),
//   - ANSI escapes (bash, logs) are rendered with real colour,
//   - each block has a copy button and shows line/byte counts.

import React, { memo, useMemo, useState } from "react";
import { AnsiRenderer, hasAnsi } from "./AnsiRenderer";

export interface ToolResultViewerProps {
  name: string;
  input?: unknown;
  inputPreview?: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  status?: "running" | "ok" | "error" | string;
}

const LINE_LIMIT = 40;
const CHAR_LIMIT = 1800;

function isLarge(text: string): boolean {
  return text.length > CHAR_LIMIT || text.split("\n").length > LINE_LIMIT;
}

/** Returns the parsed value if `text` looks like a JSON document, else null. */
function tryJson(text: string): unknown | null {
  const t = text.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <path d="M8 4V2.5A1.5 1.5 0 0 0 6.5 1H2.5A1.5 1.5 0 0 0 1 2.5v4A1.5 1.5 0 0 0 2.5 8H4" />
  </svg>
);
const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M2 6.2 4.6 8.8 10 3.4" />
  </svg>
);

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="trv-caret" style={{ transform: open ? "rotate(90deg)" : "none" }}>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M6 3.5 10.5 8 6 12.5" />
      </svg>
    </span>
  );
}

function Block({ label, text, tone }: { label: string; text: string; tone?: "err" }) {
  const [open, setOpen] = useState(() => !isLarge(text));
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => tryJson(text), [text]);
  const ansi = hasAnsi(text);
  const shown = useMemo(() => (json ? JSON.stringify(json, null, 2) : text), [json, text]);
  const lines = shown.split("\n");
  const preview = lines.slice(0, 6).join("\n");
  const hidden = lines.length - 6;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  const toggle = () => setOpen((o) => !o);

  return (
    <div className={`trv-block${tone === "err" ? " tone-err" : ""}`}>
      <div className="trv-header">
        <button
          type="button"
          className="trv-toggle"
          onClick={toggle}
          aria-expanded={open}
          title={open ? "Collapse" : "Expand"}
        >
          <Chevron open={open} />
          <span className="trv-label">{label}</span>
          <span className="trv-kind">{json ? "JSON" : ansi ? "raw" : "text"}</span>
          <span className="trv-meta">
            {lines.length} ln · {bytesLabel(shown.length)}
          </span>
        </button>
        <span className="trv-spacer" />
        <button
          type="button"
          className="trv-copy"
          onClick={() => {
            void copy();
          }}
          title={copied ? "Copied" : "Copy"}
          aria-label={copied ? "Copied" : "Copy"}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>

      {open ? (
        <pre className={`trv-pre${json ? " json" : ""}`}>{ansi ? <AnsiRenderer text={text} /> : shown}</pre>
      ) : (
        <button
          type="button"
          className="trv-collapsed"
          onClick={toggle}
          aria-expanded={false}
          title="Expand"
        >
          <pre>
            {preview}
            {hidden > 0 ? `\n… ${hidden} more lines…` : ""}
          </pre>
          <span className="trv-expand">Expand {hidden > 0 ? `(${hidden} lines)` : ""}</span>
        </button>
      )}
    </div>
  );
}

export function ToolResultViewer({ name, input, inputPreview, output, stdout, stderr, status }: ToolResultViewerProps) {
  const inputText = useMemo(() => {
    if (input != null && typeof input === "object") return JSON.stringify(input, null, 2);
    if (typeof input === "string") return input;
    return inputPreview ?? "";
  }, [input, inputPreview]);

  return (
    <div className="trv">
      <div className="trv-top">
        <span className={`trv-status ${status ?? "ok"}`} />
        <span className="trv-tool">{name}</span>
        {status && <span className="trv-status-label">{status}</span>}
      </div>
      {inputText ? <Block label="Input" text={inputText} /> : null}
      {stdout ? <Block label="stdout" text={stdout} /> : null}
      {stderr ? <Block label="stderr" text={stderr} tone="err" /> : null}
      {!stdout && !stderr && output ? <Block label="Output" text={output} /> : null}
    </div>
  );
}

export default memo(ToolResultViewer);
