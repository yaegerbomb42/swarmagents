/**
 * Component tests for the computer-use action overlay: a click ripple /
 * cursor reticle at the action's framebuffer coordinates plus a floating HUD
 * chip, all pointer-events-none so a human takeover is never intercepted.
 * Static renders (see testing/harness.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";
import { DESKTOP_FRAMEBUFFER, type ComputerAction } from "../../../lib/client/presence";

const h = React.createElement;

/** Components are imported after the browser stubs are in place. */
async function load() {
  installBrowserStubs();
  return import("./ComputerActionOverlay");
}

function action(partial: Partial<ComputerAction> & { kind: ComputerAction["kind"] }): ComputerAction {
  return {
    at: Date.now(),
    framebuffer: DESKTOP_FRAMEBUFFER,
    ...partial,
  };
}

test("a fresh click renders the ripple at the right framebuffer position", async () => {
  const { ComputerActionOverlay } = await load();
  const markup = renderToStaticMarkup(
    h(ComputerActionOverlay, { action: action({ kind: "click", x: 640, y: 420 }) }),
  );
  assert.ok(markup.includes('data-testid="computer-action-overlay"'), "overlay renders");
  assert.ok(markup.includes('data-action-kind="click"'), "kind is marked");
  assert.ok(markup.includes("pointer-events-none"), "overlay never intercepts input");
  assert.ok(markup.includes('data-testid="computer-action-point"'), "point renders");
  assert.ok(markup.includes(`left:${(640 / 1600) * 100}%`), "left is the x fraction of the framebuffer");
  assert.ok(markup.includes(`top:${(420 / 900) * 100}%`), "top is the y fraction of the framebuffer");
  assert.ok(markup.includes('data-a1-cursor="click"'), "the point is marked as A1's cursor");
  assert.ok(markup.includes("sa-click-ripple"), "click plays the ripple");
  assert.ok(markup.includes("A1"), "chip names the cursor's owner");
  assert.ok(markup.includes("Clicking (640, 420)"), "chip names the action and coordinates");
});

test("coordinates use the action's framebuffer, not a hardcoded screen size", async () => {
  const { ComputerActionOverlay } = await load();
  const framebuffer = { width: 1024, height: 768 };
  const markup = renderToStaticMarkup(
    h(ComputerActionOverlay, {
      action: action({ kind: "click", x: 512, y: 192, framebuffer }),
    }),
  );
  assert.ok(markup.includes("left:50%"), "x scales against the action's framebuffer width");
  assert.ok(markup.includes("top:25%"), "y scales against the action's framebuffer height");
});

test("a move renders the reticle, not the ripple", async () => {
  const { ComputerActionOverlay } = await load();
  const markup = renderToStaticMarkup(
    h(ComputerActionOverlay, { action: action({ kind: "move", x: 100, y: 200 }) }),
  );
  assert.ok(markup.includes("sa-reticle-pulse"), "move pulses the reticle");
  assert.ok(!markup.includes("sa-click-ripple"), "move does not ripple");
  assert.ok(markup.includes("Moving to (100, 200)"), "chip names the move");
});

test("an action without coordinates renders only the HUD chip", async () => {
  const { ComputerActionOverlay } = await load();
  const markup = renderToStaticMarkup(
    h(ComputerActionOverlay, { action: action({ kind: "type", detail: "(12 chars)" }) }),
  );
  assert.ok(markup.includes('data-testid="computer-action-overlay"'), "overlay renders");
  assert.ok(!markup.includes('data-testid="computer-action-point"'), "no point without coordinates");
  assert.ok(markup.includes('data-typing-badge="true"'), "typing renders a distinct badge");
  assert.ok(markup.includes("Typing (12 chars)"), "chip names the typing");
  assert.ok(!markup.includes("hunter2"), "chip never carries typed content");
});

test("a navigate action chips the host, a screenshot chips the action", async () => {
  const { ComputerActionOverlay } = await load();
  const nav = renderToStaticMarkup(
    h(ComputerActionOverlay, { action: action({ kind: "navigate", detail: "example.com" }) }),
  );
  assert.ok(nav.includes("Opening example.com"), "chip names the navigation target");
  const shot = renderToStaticMarkup(
    h(ComputerActionOverlay, { action: action({ kind: "screenshot" }) }),
  );
  assert.ok(shot.includes("Taking a screenshot"), "chip names the screenshot");
});

test("a stale action renders nothing", async () => {
  const { ComputerActionOverlay } = await load();
  const markup = renderToStaticMarkup(
    h(ComputerActionOverlay, {
      action: action({ kind: "click", x: 640, y: 420, at: Date.now() - 60_000 }),
    }),
  );
  assert.equal(markup, "", "replayed actions do not paint phantom ripples");
});

test("no action renders nothing", async () => {
  const { ComputerActionOverlay } = await load();
  assert.equal(renderToStaticMarkup(h(ComputerActionOverlay, {})), "");
  assert.equal(renderToStaticMarkup(h(ComputerActionOverlay, { action: undefined })), "");
});
