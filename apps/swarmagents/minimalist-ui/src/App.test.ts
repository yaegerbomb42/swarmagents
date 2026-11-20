import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf, installBrowserStubs, tagOf, type BrowserStubOptions } from "./testing/harness";

/**
 * The new shell, rendered as the server would send it: one workspace with a
 * header, a chat column and a stage (the computer's screen or the board).
 */
async function renderApp(options: BrowserStubOptions = {}): Promise<string> {
  installBrowserStubs(options);
  const { default: App } = await import("./App");
  const { ToastsProvider } = await import("./components/Toasts");
  return renderToStaticMarkup(React.createElement(ToastsProvider, null, React.createElement(App)));
}

const ALWAYS_IN_REACH = ["workspace-header", "open-history", "new-chat", "open-settings", "composer-input", "composer-send"];

test("the workspace opens on the chat: one header, one view switch, one composer", async () => {
  const html = await renderApp();

  assert.match(tagOf(html, "minimal-main-page"), /data-view="chat"/);
  for (const id of ALWAYS_IN_REACH) assert.equal(countOf(html, `data-testid="${id}"`), 1, id);
  for (const view of ["chat", "screen", "board"]) {
    assert.equal(countOf(html, `data-testid="view-${view}"`), 1, `one ${view} tab`);
  }
  assert.match(tagOf(html, "view-chat"), /aria-selected="true"/);
  assert.equal(countOf(html, 'data-testid="stage"'), 0, "no stage until a view asks for one");
  assert.match(tagOf(html, "composer-input"), /aria-label="Message the agent"/);
  assert.match(tagOf(html, "open-settings"), /aria-label="Settings"/);
});

test("the approval prompt's layer is mounted in every view", async () => {
  for (const view of ["chat", "screen", "board"]) {
    const html = await renderApp({ local: { "sa.view": view } });
    assert.equal(countOf(html, 'data-testid="approval-layer"'), 1, view);
  }
});

test("the screen view puts the computer on stage, with its status, beside the chat", async () => {
  for (const wide of [false, true]) {
    const html = await renderApp({ local: { "sa.view": "screen" }, wide });

    assert.match(tagOf(html, "minimal-main-page"), /data-view="screen"/);
    assert.match(tagOf(html, "view-screen"), /aria-selected="true"/);
    for (const id of ["stage", "screen-frame", "screen-toolbar", "screen-status-pill", "screen-stage"]) {
      assert.equal(countOf(html, `data-testid="${id}"`), 1, `${id} (wide: ${wide})`);
    }
    assert.doesNotMatch(tagOf(html, "chat-column"), /hidden=""/, "the chat stays with the screen");
    for (const id of ALWAYS_IN_REACH) assert.equal(countOf(html, `data-testid="${id}"`), 1, id);
  }
});

test("the board is part of the same workspace: beside the chat when wide, the whole view on a phone", async () => {
  const wide = await renderApp({ local: { "sa.view": "board" }, wide: true });
  assert.equal(countOf(wide, 'data-testid="board-panel"'), 1);
  assert.doesNotMatch(tagOf(wide, "chat-column"), /hidden=""/);
  assert.match(tagOf(wide, "view-board"), /aria-selected="true"/);

  const phone = await renderApp({ local: { "sa.view": "board" }, wide: false });
  assert.equal(countOf(phone, 'data-testid="board-panel"'), 1);
  assert.match(tagOf(phone, "chat-column"), /hidden=""/, "kept mounted so the draft survives, but out of view");
  for (const view of ["chat", "screen", "board"]) {
    assert.equal(countOf(phone, `data-testid="view-${view}"`), 1, `the way back to ${view} is still there`);
  }
});

test("nothing in the shell is a placeholder", async () => {
  for (const view of ["chat", "screen", "board"]) {
    const html = await renderApp({ local: { "sa.view": view }, wide: true });
    assert.doesNotMatch(html, /coming soon|not implemented|todo/i, view);
  }
});
