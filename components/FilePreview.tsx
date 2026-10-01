"use client";

import { useEffect, useState } from "react";
import "./preview.css";

// Inline previews for files the agent made or fetched: images, PDF, video/audio, CSV tables,
// markdown/code/text (paged), and a download link for everything else. Served by /api/files,
// which keeps previews inside the task's folder and sandboxes them.

type Meta = { path: string; name: string; size: number; mtime: number; mime: string; kind: "image" | "pdf" | "video" | "audio" | "table" | "markdown" | "text" | "binary" };

const PAGE = 400;
const MAX_TEXT = 2 * 1024 * 1024;

export const fileUrl = (session: string, path: string, extra = "") =>
  `/api/files?session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}${extra}`;

export function fmtBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Minimal RFC 4180 CSV/TSV parser (quotes, escaped quotes, newlines inside quotes). */
export function parseDelimited(text: string, sep = ",", maxRows = 500): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') (cell += '"'), i++;
        else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === sep) row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      total++;
      if (rows.length < maxRows) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    total++;
    if (rows.length < maxRows) rows.push(row);
  }
  return { rows, total };
}

export function FilePreview({ session, path, onClose, full }: { session: string; path: string; onClose?: () => void; full?: boolean }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const url = fileUrl(session, path);

  useEffect(() => {
    let live = true;
    setMeta(null);
    setErr("");
    setText(null);
    fetch(fileUrl(session, path, "&meta=1"))
      .then(async (r) => {
        const d = await r.json().catch(() => ({ error: `The server answered ${r.status}.` }));
        if (!r.ok) throw new Error(d.error ?? "Couldn't open the file.");
        return d as Meta;
      })
      .then(async (m) => {
        if (!live) return;
        setMeta(m);
        if ((m.kind === "text" || m.kind === "markdown" || m.kind === "table") && m.size <= MAX_TEXT) {
          const t = await (await fetch(url)).text();
          if (live) setText(t);
        }
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [session, path, url]);

  const name = meta?.name ?? path.split("/").pop() ?? path;
  return (
    <div className="fp">
      <div className="fp-head">
        <span className="fp-name" title={meta?.path ?? path}>
          {name}
        </span>
        {meta && <span className="fp-size">{fmtBytes(meta.size)}</span>}
        <span className="fp-sp" />
        {!full && (
          <a className="fp-act" href={`/preview?session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`} target="_blank" rel="noreferrer">
            Full view
          </a>
        )}
        <a className="fp-act" href={url} target="_blank" rel="noreferrer">
          Raw
        </a>
        <a className="fp-act" href={fileUrl(session, path, "&download=1")}>
          Download
        </a>
        {onClose && (
          <button className="fp-act" onClick={onClose} aria-label="Close preview">
            ✕
          </button>
        )}
      </div>
      <div className="fp-body">
        {err ? (
          <div className="fp-msg err">{err}</div>
        ) : !meta ? (
          <div className="fp-msg">Loading…</div>
        ) : meta.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="fp-img" src={url} alt={name} />
        ) : meta.kind === "pdf" ? (
          <iframe className="fp-frame" src={url} title={name} />
        ) : meta.kind === "video" ? (
          <video className="fp-media" src={url} controls preload="metadata" />
        ) : meta.kind === "audio" ? (
          <audio src={url} controls preload="metadata" />
        ) : meta.size > MAX_TEXT && meta.kind !== "binary" ? (
          <div className="fp-msg">Too large to show inline ({fmtBytes(meta.size)}). Use Raw or Download.</div>
        ) : meta.kind === "table" && text !== null ? (
          <Table text={text} sep={name.toLowerCase().endsWith(".tsv") ? "\t" : ","} />
        ) : (meta.kind === "text" || meta.kind === "markdown") && text !== null ? (
          <TextView text={text} pages={pages} more={() => setPages((p) => p + 1)} />
        ) : meta.kind === "binary" ? (
          <div className="fp-msg">
            No inline preview for this type ({meta.mime}). Use Download to open it on your computer.
          </div>
        ) : (
          <div className="fp-msg">Loading…</div>
        )}
      </div>
    </div>
  );
}

function Table({ text, sep }: { text: string; sep: string }) {
  const { rows, total } = parseDelimited(text, sep);
  if (!rows.length) return <div className="fp-msg">Empty file.</div>;
  const [head, ...body] = rows;
  return (
    <div className="fp-table-wrap">
      <table className="fp-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {head.map((_, j) => (
                <td key={j}>{r[j] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fp-foot">
        {total - 1} row{total - 1 === 1 ? "" : "s"}
        {total > rows.length ? ` · showing the first ${rows.length - 1}` : ""}
      </div>
    </div>
  );
}

function TextView({ text, pages, more }: { text: string; pages: number; more: () => void }) {
  const lines = text.split("\n");
  const shown = lines.slice(0, pages * PAGE);
  return (
    <div className="fp-text-wrap">
      <pre className="fp-text">
        {shown.map((l, i) => (
          <div key={i} className="fp-line">
            <span className="fp-ln">{i + 1}</span>
            <span>{l || " "}</span>
          </div>
        ))}
      </pre>
      {lines.length > shown.length && (
        <button className="fp-more" onClick={more}>
          Show {Math.min(PAGE, lines.length - shown.length)} more of {lines.length - shown.length} remaining lines
        </button>
      )}
    </div>
  );
}

/** A small "Preview" toggle for tool cards: shows the file inline under the card. */
export function PreviewChip({ session, path, label = "Preview" }: { session: string; path: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="fp-chip-wrap">
      <button className={`fp-chip${open ? " on" : ""}`} onClick={() => setOpen((o) => !o)} title={path}>
        {open ? "Hide preview" : label}
      </button>
      {open && <FilePreview session={session} path={path} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** Paths the agent reported producing in a tool output (browser downloads, "Wrote …", saved to …). */
export function producedFiles(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/(?:Downloaded .+? to |Wrote (?:\d+ \S+ to )?|[Ss]aved (?:it )?to |full output saved to )((?:~|\/)[^\s"'`)\]]+)/g)) out.add(m[1].replace(/[.,;:]$/, ""));
  return [...out];
}
