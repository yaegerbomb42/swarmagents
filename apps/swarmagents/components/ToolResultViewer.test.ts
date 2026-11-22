import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolResultViewer } from "./ToolResultViewer";

test("ToolResultViewer renders toggle and copy as separate native buttons with aria-expanded", () => {
  const html = renderToStaticMarkup(
    React.createElement(ToolResultViewer, {
      name: "bash",
      output: "hello world",
    })
  );

  // Toggle must be a native button with aria-expanded and class trv-toggle
  assert.match(html, /<button[^>]*class="trv-toggle"[^>]*aria-expanded="true"[^>]*>/);

  // Copy button must be a native button
  assert.match(html, /<button[^>]*class="trv-copy"[^>]*>/);

  // Toggle button must close before the copy button opens (they are siblings)
  assert.match(html, /<\/button><span class="trv-spacer"><\/span><button[^>]*class="trv-copy"/);
});

test("ToolResultViewer collapsed view renders as a native button with aria-expanded=false", () => {
  // Generate text that exceeds CHAR_LIMIT or LINE_LIMIT so it defaults to collapsed
  const largeText = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const html = renderToStaticMarkup(
    React.createElement(ToolResultViewer, {
      name: "bash",
      output: largeText,
    })
  );

  // Toggle button should be aria-expanded="false"
  assert.match(html, /<button[^>]*class="trv-toggle"[^>]*aria-expanded="false"[^>]*>/);

  // Collapsed preview should also be a native button with aria-expanded="false"
  assert.match(html, /<button[^>]*class="trv-collapsed"[^>]*aria-expanded="false"[^>]*>/);
});
