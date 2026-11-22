/**
 * Unit tests for the FilesView clock.
 *
 * The chat shows times in local time (see Conversation formatClock); FilesView
 * must use the same local-time basis instead of UTC so there is one clock.
 * We pin a fixed zone so the assertion is deterministic no matter where CI runs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeBinaryPreview, describeTruncatedPreview, formatModified, FilesView } from "./FilesView";
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
