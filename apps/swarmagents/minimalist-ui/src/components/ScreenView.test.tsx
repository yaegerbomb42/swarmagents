/**
 * ScreenView tests (l4): the unavailable empty state, and the available
 * path mounting the desktop surface with the paste button. Static renders
 * (see testing/harness.ts): effects never run, so the connection sits at
 * its initial phase and paste stays disabled until a live, controlled
 * socket reports in.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";

const h = React.createElement;

/** Components are imported after the browser stubs are in place (noVNC). */
async function load() {
  installBrowserStubs();
  return import("./ScreenView");
}

test("unavailable: an errored VM shows the empty state and never mounts the surface", async () => {
  const { ScreenView } = await load();
  const markup = renderToStaticMarkup(h(ScreenView, { vmState: "error" }));
  assert.match(markup, /data-testid="screen-view-unavailable"/);
  assert.match(markup, /Desktop not available on this server/);
  assert.doesNotMatch(markup, /data-testid="desktop-view"/);
  assert.doesNotMatch(markup, /screen-paste-clipboard/);
});

test("unavailable: a hibernated VM names the wake-up, not a generic error", async () => {
  const { ScreenView } = await load();
  const markup = renderToStaticMarkup(h(ScreenView, { vmState: "hibernated" }));
  assert.match(markup, /data-testid="screen-view-unavailable"/);
  assert.match(markup, /hibernated/);
});

test("available: mounts the desktop surface with the paste button disabled until control", async () => {
  const { ScreenView } = await load();
  const markup = renderToStaticMarkup(h(ScreenView, { vmState: "ready" }));
  assert.match(markup, /data-testid="screen-view"/);
  assert.match(markup, /data-testid="desktop-view"/);
  assert.match(markup, /data-testid="screen-paste-clipboard"/);
  // No live controlled socket yet, so paste is disabled.
  assert.match(markup, /disabled/);
  assert.doesNotMatch(markup, /screen-refusal-message/);
});
