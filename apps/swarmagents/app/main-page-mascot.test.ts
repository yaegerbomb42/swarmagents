import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Render test for the main page: the minimal shell carries no brand lockup
 * in a header — the only top chrome is the settings icon, and before the
 * first run the desktop area is one quiet launch line. The page's module
 * graph pulls in noVNC (which touches browser globals at import time), so
 * install the minimal DOM stubs before importing it. Effects never run
 * during a static render, which is exactly what makes this a deterministic
 * check of the server-visible markup.
 */
function installBrowserStubs(hash: string) {
  const g = globalThis as unknown as Record<string, unknown>;

  class StubObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const element = () => ({
    style: {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    getContext: () => null,
    getElementsByTagName: () => [],
  });

  g.window = {
    console,
    location: { hash },
    history: { replaceState() {} },
    localStorage: storage,
    sessionStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  };
  g.document = {
    documentElement: { style: {}, appendChild() {}, removeChild() {} },
    body: { appendChild() {}, removeChild() {} },
    createElement: element,
    querySelector: () => null,
    getElementsByTagName: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  g.localStorage = storage;
  g.sessionStorage = storage;
  g.MediaStream = class {};
  g.MutationObserver = StubObserver;
  g.ResizeObserver = StubObserver;
  g.requestAnimationFrame = (cb: (time: number) => void) => setTimeout(() => cb(0), 0);
  g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  // TSX is compiled with the classic transform outside Next.
  g.React = React;
}

test("the main page shows the minimal shell on first load: settings icon, no brand lockup, no hero", async () => {
  installBrowserStubs("#view=computer&tab=terminal");

  const { default: App } = await import("../minimalist-ui/src/App");
  const { ToastsProvider } = await import("../minimalist-ui/src/components/Toasts");

  const html = renderToStaticMarkup(
    React.createElement(ToastsProvider, null, React.createElement(App)),
  );

  assert.ok(!html.includes('data-testid="brand-lockup"'), "no brand lockup in the shell");
  assert.ok(!html.includes("/brand/mark-dark.svg"), "no cursor-eye mark on the main page");
  assert.ok(!html.includes('data-testid="workspace-header"'), "no header bar");
  assert.ok(!html.includes('data-testid="workspace-hero"'), "no hero block");
  assert.ok(html.includes('data-testid="open-settings"'), "the settings icon is the only top chrome");
  assert.ok(html.includes('data-testid="launch-desktop-btn"'), "one quiet launch line for the desktop");
  assert.ok(!html.includes('data-testid="mascot-svg"'), "the mascot is gone from the main page");
});
