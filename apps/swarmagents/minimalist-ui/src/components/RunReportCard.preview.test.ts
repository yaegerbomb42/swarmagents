/**
 * Tests for the run report card's artifact preview: the kind classifier,
 * the text cap, and the presentational preview panel. The panel is static
 * markup (see testing/harness.ts), so each state is a deterministic render.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ARTIFACT_PREVIEW_MAX_CHARS,
  ARTIFACT_PREVIEW_MAX_LINES,
  ArtifactPreviewPanel,
  artifactPreviewKind,
  capPreviewText,
  isPdfBytes,
} from "./RunReportCard";
import type { ReportArtifact } from "../../../lib/runtime/run-report-types";

function artifact(rel: string): ReportArtifact {
  return { path: `/workspace/${rel}`, rel, size: 100, mtimeMs: 0, change: "created" };
}

test("artifactPreviewKind classifies images, text and everything else", () => {
  assert.equal(artifactPreviewKind("photo.png"), "image");
  assert.equal(artifactPreviewKind("photo.JPG"), "image");
  assert.equal(artifactPreviewKind("shot.jpeg"), "image");
  assert.equal(artifactPreviewKind("drawing.svg"), "image");
  assert.equal(artifactPreviewKind("notes.md"), "text");
  assert.equal(artifactPreviewKind("data.json"), "text");
  assert.equal(artifactPreviewKind("script.py"), "text");
  assert.equal(artifactPreviewKind("table.csv"), "text");
  assert.equal(artifactPreviewKind("style.css"), "text");
  assert.equal(artifactPreviewKind("archive.zip"), "none");
  assert.equal(artifactPreviewKind("document.pdf"), "none");
  assert.equal(artifactPreviewKind("Makefile"), "none");
  assert.equal(artifactPreviewKind("weird.xyz"), "none");
  assert.equal(artifactPreviewKind("no-extension"), "none");
});

test("capPreviewText passes through short text unchanged", () => {
  const result = capPreviewText("hello\nworld");
  assert.equal(result.text, "hello\nworld");
  assert.equal(result.truncated, false);
});

test("capPreviewText truncates past the character cap", () => {
  const long = "x".repeat(ARTIFACT_PREVIEW_MAX_CHARS + 10);
  const result = capPreviewText(long);
  assert.equal(result.text.length, ARTIFACT_PREVIEW_MAX_CHARS);
  assert.equal(result.truncated, true);
});

test("capPreviewText truncates past the line cap", () => {
  const text = Array.from({ length: ARTIFACT_PREVIEW_MAX_LINES + 3 }, (_, i) => `line ${i}`).join("\n");
  const result = capPreviewText(text);
  assert.equal(result.text.split("\n").length, ARTIFACT_PREVIEW_MAX_LINES);
  assert.equal(result.truncated, true);
});

test("capPreviewText does not truncate exactly at the caps", () => {
  const atCharLimit = "y".repeat(ARTIFACT_PREVIEW_MAX_CHARS);
  assert.equal(capPreviewText(atCharLimit).truncated, false);
  const atLineLimit = Array.from({ length: ARTIFACT_PREVIEW_MAX_LINES }, () => "line").join("\n");
  assert.equal(capPreviewText(atLineLimit).truncated, false);
});

test("preview panel renders an image with the object URL and download action", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ArtifactPreviewPanel, {
      artifact: artifact("photo.png"),
      reportRunId: "run_1",
      state: { kind: "image", url: "blob:preview" },
      onClose: () => {},
    }),
  );
  assert.ok(markup.includes('data-testid="artifact-preview"'), "panel renders");
  assert.ok(markup.includes('data-testid="artifact-preview-image"'), "image preview renders");
  assert.ok(markup.includes('src="blob:preview"'), "image uses the object URL");
  assert.ok(markup.includes("report/artifacts?path=photo.png"), "download action points at the artifact");
});

test("preview panel renders capped text and notes truncation", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ArtifactPreviewPanel, {
      artifact: artifact("notes.md"),
      reportRunId: "run_1",
      state: { kind: "text", text: "hello", truncated: true },
      onClose: () => {},
    }),
  );
  assert.ok(markup.includes('data-testid="artifact-preview-text"'), "text preview renders");
  assert.ok(markup.includes("hello"), "preview shows the text");
  assert.ok(markup.includes("Preview is truncated"), "truncation is surfaced");
});

test("preview panel explains when the file type cannot be previewed", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ArtifactPreviewPanel, {
      artifact: artifact("archive.zip"),
      reportRunId: "run_1",
      state: { kind: "none" },
      onClose: () => {},
    }),
  );
  assert.ok(markup.includes('data-testid="artifact-preview-none"'), "no-preview note renders");
  assert.ok(markup.includes("No preview for this file type"), "the note explains why");
});

test("preview panel surfaces a load error", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ArtifactPreviewPanel, {
      artifact: artifact("notes.md"),
      reportRunId: "run_1",
      state: { kind: "text", error: "Could not load the preview." },
      onClose: () => {},
    }),
  );
  assert.ok(markup.includes('data-testid="artifact-preview-error"'), "error renders");
  assert.ok(markup.includes("Could not load the preview."), "the error message shows");
});

test("preview panel renders sandboxed HTML without allow-same-origin", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ArtifactPreviewPanel, {
      artifact: artifact("report.html"),
      reportRunId: "run_1",
      state: { kind: "text", text: "<h1>Hello</h1><script>console.log(1)</script>" },
      onClose: () => {},
    }),
  );
  assert.ok(markup.includes('data-testid="artifact-preview-html"'), "HTML sandbox iframe renders");
  assert.ok(markup.includes('sandbox="allow-scripts"'), "sandbox allows scripts only");
  assert.ok(!markup.includes("allow-same-origin"), "sandbox must never include allow-same-origin");
  assert.ok(markup.includes("Content-Security-Policy"), "strict CSP meta tag is injected");
  assert.ok(markup.includes('data-testid="artifact-preview-toggle-raw"'), "raw toggle renders");
});

test("preview panel renders CSV as a sortable table", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ArtifactPreviewPanel, {
      artifact: artifact("metrics.csv"),
      reportRunId: "run_1",
      state: { kind: "text", text: 'name,score\n"Alice, A",10\nBob,25\n' },
      onClose: () => {},
    }),
  );
  assert.ok(markup.includes('data-testid="artifact-preview-csv"'), "CSV table renders");
  assert.ok(markup.includes("Alice, A"), "quoted comma field is parsed cleanly");
  assert.ok(markup.includes("25"), "numeric cell renders");
  assert.ok(markup.includes('data-testid="artifact-preview-toggle-raw"'), "raw toggle renders");
});

test("preview panel renders PDF inline iframe when blob url is present", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ArtifactPreviewPanel, {
      artifact: artifact("summary.pdf"),
      reportRunId: "run_1",
      state: { kind: "none", url: "blob:http://localhost/pdf-1" },
      onClose: () => {},
    }),
  );
  assert.ok(markup.includes('data-testid="artifact-preview-pdf"'), "PDF iframe renders");
  assert.ok(markup.includes("blob:http://localhost/pdf-1"), "blob URL is wired into iframe");
});

test("PDF magic-byte guard rejects HTML bytes", () => {
  const html = "<script>alert(1)</script>";
  const bytes = new TextEncoder().encode(html).buffer;
  assert.equal(isPdfBytes(bytes), false, "HTML bytes are not a PDF");
  assert.equal(isPdfBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), true, "PDF magic bytes pass");
});

test("HTML bytes in a .pdf must not produce an iframe", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ArtifactPreviewPanel, {
      artifact: artifact("report.pdf"),
      reportRunId: "run_1",
      state: { kind: "none" },
      onClose: () => {},
    }),
  );
  assert.ok(!markup.includes('data-testid="artifact-preview-pdf"'), "no PDF iframe renders");
});
