import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Render test for the main page: it must put the brand lockup (cursor-eye
 * mark + wordmark) in the header on first load. The page's module graph pulls
 * in noVNC (which touches browser globals at import time), so install the
 * minimal DOM stubs before importing it. Effects never run during a static
 * render, which is exactly what makes this a deterministic check of the
 * server-visible markup.
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

test("the main page shows the brand lockup in the header on first load", async () => {
  installBrowserStubs("#view=computer&tab=terminal");

  const { default: App } = await import("../minimalist-ui/src/App");
  const { ToastsProvider } = await import("../minimalist-ui/src/components/Toasts");

  const html = renderToStaticMarkup(
    React.createElement(ToastsProvider, null, React.createElement(App)),
  );

  assert.ok(html.includes('data-testid="brand-lockup"'), "brand lockup is in the header");
  assert.ok(html.includes("/brand/mark-dark.svg"), "the cursor-eye mark renders on dark");
  assert.ok(html.includes("SwarmAgents"), "the wordmark renders next to the mark");
  assert.ok(!html.includes('data-testid="mascot-svg"'), "the mascot is gone from the main page");
});
