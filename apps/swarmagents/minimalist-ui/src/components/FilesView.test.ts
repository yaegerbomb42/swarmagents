/**
 * Unit tests for the FilesView clock.
 *
 * The chat shows times in local time (see Conversation formatClock); FilesView
 * must use the same local-time basis instead of UTC so there is one clock.
 * We pin a fixed zone so the assertion is deterministic no matter where CI runs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CsvTable,
  csvRows,
  describeBinaryPreview,
  describeTruncatedPreview,
  formatModified,
  FilesView,
  previewVariantForPath,
  relativeAge,
} from "./FilesView";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf, installBrowserStubs } from "../testing/harness";

// PST (UTC-8) in November has no DST, so the expected value is stable.
process.env.TZ = "America/Los_Angeles";

test("formatModified renders an em dash for missing or invalid timestamps", () => {
  assert.equal(formatModified(), "—");
  assert.equal(formatModified(NaN), "—");
  assert.equal(formatModified(Number.POSITIVE_INFINITY), "—");
});

test("formatModified shows the local-time equivalent of a UTC timestamp", () => {
  // 2026-11-20 20:05 UTC == 12:05 PST (America/Los_Angeles, Nov = standard time).
  const ts = Date.UTC(2026, 10, 20, 20, 5);
  assert.equal(formatModified(ts), "2026-11-20 12:05");
});

test("formatModified uses local getters, not UTC getters", () => {
  const ts = Date.UTC(2026, 2, 15, 8, 30);
  const d = new Date(ts);
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  assert.equal(formatModified(ts), expected);
});

test("file preview notices explain unsupported types and size limits plainly", () => {
  assert.equal(describeBinaryPreview(1200), "This file type can’t be previewed here. File size: 1.2 KB.");
  assert.equal(
    describeTruncatedPreview(1024, 4096),
    "Only the first 1.0 KB of 4.0 KB is shown. Download the file to see the rest.",
  );
});

test("files empty state explains workspace and first run", () => {
  installBrowserStubs();
  const html = renderToStaticMarkup(React.createElement(FilesView, {}));
  // Before listing arrives it is in loading state
  assert.match(html, /Loading workspace/);
  assert.equal(countOf(html, 'data-testid="files-empty"'), 0);
});

// ---------------------------------------------------------------------------
// CSV previews
// ---------------------------------------------------------------------------

test("csvRows parses quoted fields, doubled quotes, and CRLF", () => {
  const { rows, hidden } = csvRows('a,b\n"1,5","he said ""hi"""\r\n2,3\n');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1,5", 'he said "hi"'],
    ["2", "3"],
  ]);
  assert.equal(hidden, 0);
});

test("csvRows caps rendered rows and counts the rest as hidden", () => {
  const content = Array.from({ length: 12 }, (_, i) => `r${i},x`).join("\n");
  const { rows, hidden } = csvRows(content, 10);
  assert.equal(rows.length, 10);
  assert.equal(hidden, 2);
  assert.equal(rows[0][0], "r0");
});

test("csvRows treats an empty file as zero rows", () => {
  assert.deepEqual(csvRows("").rows, []);
  assert.deepEqual(csvRows("\n\n").rows, []);
});

test("CsvTable renders a header row and hides extra rows behind a footer", () => {
  installBrowserStubs();
  const content = Array.from({ length: 150 }, (_, i) => `col,row${i}`).join("\n");
  const html = renderToStaticMarkup(React.createElement(CsvTable, { content }));
  assert.match(html, /data-testid="files-csv-table"/);
  assert.match(html, /col/);
  assert.match(html, /50 more rows in the file/);
});

// ---------------------------------------------------------------------------
// Image previews
// ---------------------------------------------------------------------------

test("previewVariantForPath classifies images and csv without an entry", () => {
  assert.equal(previewVariantForPath("/workspace/photo.png"), "image");
  assert.equal(previewVariantForPath("/workspace/a/b/data.csv"), "csv");
  assert.equal(previewVariantForPath("/workspace/notes.tsv"), "csv");
  assert.equal(previewVariantForPath("/workspace/main.go"), "code");
  assert.equal(previewVariantForPath("/workspace/README.md"), "text");
});

// ---------------------------------------------------------------------------
// Recent strip ages
// ---------------------------------------------------------------------------

test("relativeAge buckets ages into human labels", () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeAge(now - 30_000, now), "just now");
  assert.equal(relativeAge(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeAge(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relativeAge(undefined, now), "");
  // A future timestamp never goes negative.
  assert.equal(relativeAge(now + 60_000, now), "just now");
});
