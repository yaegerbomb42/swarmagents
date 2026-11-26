import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveAppPreviewPill } from "./VmChrome";

test("LiveAppPreviewPill renders nothing when no ports are listening", () => {
  const markup = renderToStaticMarkup(React.createElement(LiveAppPreviewPill, { ports: [] }));
  assert.equal(markup, "");
});

test("LiveAppPreviewPill renders Open App (:PORT) pill linking to /preview/<port>/", () => {
  const markup = renderToStaticMarkup(React.createElement(LiveAppPreviewPill, { ports: [9222, 3000, 5173] }));
  assert.ok(markup.includes('data-testid="live-app-preview-pill"'));
  assert.ok(markup.includes('href="/preview/3000/"'));
  assert.ok(markup.includes("Open App (:3000)"));
  assert.ok(markup.includes("listening: 9222, 3000, 5173"));
});
