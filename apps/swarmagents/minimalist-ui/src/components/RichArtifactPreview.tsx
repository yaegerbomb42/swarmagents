"use client";

import React, { useMemo, useState } from "react";

export type RichArtifactRendererKind = "html" | "csv" | "pdf" | "svg";

/** Return the rich inline renderer kind for a filename, if supported. */
export function artifactRichRenderer(rel: string): RichArtifactRendererKind | null {
  const dot = rel.lastIndexOf(".");
  const ext = dot > 0 && dot < rel.length - 1 ? rel.slice(dot + 1).toLowerCase() : "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "pdf") return "pdf";
  if (ext === "svg") return "svg";
  return null;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

/**
 * Parse RFC-4180-ish CSV or TSV text into headers and rows, capped at `maxRows`
 * data rows so huge spreadsheets cannot freeze the browser.
 */
export function parseCsvRows(text: string, maxRows = 200, delimiter?: string): ParsedCsv {
  const sep = delimiter ?? (text.slice(0, 1024).includes("\t") && !text.slice(0, 1024).includes(",") ? "\t" : ",");
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let truncated = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.length > 0)) {
        records.push(row);
        if (records.length >= maxRows + 1) {
          truncated = i < text.length - 1;
          break;
        }
      }
      row = [];
    } else {
      field += ch;
    }
  }

  if (!truncated && (field.length > 0 || row.length > 0)) {
    row.push(field);
    if (row.some((c) => c.length > 0)) records.push(row);
  }

  if (records.length === 0) return { headers: [], rows: [], truncated: false };
  const headers = records[0];
  const rows = records.slice(1, maxRows + 1).map((r) => {
    if (r.length === headers.length) return r;
    const padded = r.slice(0, headers.length);
    while (padded.length < headers.length) padded.push("");
    return padded;
  });
  return { headers, rows, truncated: truncated || records.length - 1 > maxRows };
}

/** Sort CSV rows by column index (numeric-aware when both cells are finite numbers). */
export function sortCsvRows(
  rows: readonly (readonly string[])[],
  colIdx: number,
  direction: "asc" | "desc",
): string[][] {
  const factor = direction === "asc" ? 1 : -1;
  return rows
    .map((r) => [...r])
    .sort((a, b) => {
      const av = (a[colIdx] ?? "").trim();
      const bv = (b[colIdx] ?? "").trim();
      const an = av === "" ? Number.NaN : Number(av);
      const bn = bv === "" ? Number.NaN : Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn)) {
        return (an - bn) * factor;
      }
      return av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" }) * factor;
    });
}

const PREVIEW_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none';";

/**
 * Wrap untrusted artifact HTML with a strict CSP meta tag for rendering inside
 * a null-origin `<iframe sandbox="allow-scripts">` (never `allow-same-origin`).
 */
export function buildSandboxedHtmlSrcDoc(rawHtml: string): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_HTML_CSP}">`;
  const trimmed = rawHtml.trim();
  if (/<head[\s>]/i.test(trimmed)) {
    return trimmed.replace(/<head([\s>])/i, `<head$1${cspMeta}`);
  }
  if (/<html[\s>]/i.test(trimmed)) {
    return trimmed.replace(/<html([^>]*)>/i, `<html$1><head>${cspMeta}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta}<style>body{font-family:system-ui,-apple-system,sans-serif;margin:12px;color:#111;background:#fff;}</style></head><body>${rawHtml}</body></html>`;
}

export function SandboxedHtmlFrame({ html, title }: { html: string; title: string }) {
  const srcDoc = useMemo(() => buildSandboxedHtmlSrcDoc(html), [html]);
  return (
    <iframe
      title={`HTML preview of ${title}`}
      data-testid="artifact-preview-html"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="mt-2 h-64 w-full rounded-md border border-sa-line bg-white"
    />
  );
}

export function RichCsvTable({ text }: { text: string }) {
  const parsed = useMemo(() => parseCsvRows(text), [text]);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sortedRows = useMemo(() => {
    if (sortCol === null) return parsed.rows;
    return sortCsvRows(parsed.rows, sortCol, sortDir);
  }, [parsed.rows, sortCol, sortDir]);

  if (parsed.headers.length === 0) {
    return (
      <p className="mt-2 text-[12px] text-sa-fg3" data-testid="artifact-preview-csv-empty">
        CSV file is empty.
      </p>
    );
  }

  function handleSort(colIdx: number) {
    if (sortCol === colIdx) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(colIdx);
      setSortDir("asc");
    }
  }

  return (
    <div className="mt-2" data-testid="artifact-preview-csv">
      <div className="sa-scroll max-h-64 overflow-auto rounded-md border border-sa-line bg-sa-raised">
        <table className="w-full border-collapse text-left font-mono text-[11px] text-sa-fg">
          <thead className="sticky top-0 bg-sa-bg text-sa-fg2">
            <tr>
              {parsed.headers.map((header, idx) => {
                const active = sortCol === idx;
                const arrow = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
                return (
                  <th key={`${idx}-${header}`} className="border-b border-sa-line px-2 py-1 font-semibold whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort(idx)}
                      className="cursor-pointer text-left hover:text-sa-fg"
                      title={`Sort by ${header || `column ${idx + 1}`}`}
                    >
                      {header || `col_${idx + 1}`}
                      {arrow}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, rIdx) => (
              <tr key={rIdx} className="border-b border-sa-line/50 last:border-b-0 hover:bg-sa-bg/50">
                {row.map((cell, cIdx) => (
                  <td key={cIdx} className="max-w-[220px] truncate px-2 py-1" title={cell}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {parsed.truncated && (
        <p className="mt-1 text-[11px] text-sa-fg3">Showing first {parsed.rows.length} rows. Download the file to view all rows.</p>
      )}
    </div>
  );
}

export function InlinePdfPreview({ url, title }: { url: string; title: string }) {
  return (
    <iframe
      title={`PDF preview of ${title}`}
      data-testid="artifact-preview-pdf"
      src={url}
      className="mt-2 h-72 w-full rounded-md border border-sa-line bg-white"
    />
  );
}
