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
  for (const view of ["chat", "screen"]) {
    assert.equal(countOf(html, `data-testid="view-${view}"`), 1, `one ${view} tab`);
  }
  assert.equal(countOf(html, 'data-testid="view-board"'), 0, "no board tab without dev mode");
  const dev = await renderApp({ local: { "sa.devMode": true } });
  for (const view of ["chat", "screen", "board"]) {
    assert.equal(countOf(dev, `data-testid="view-${view}"`), 1, `one ${view} tab in dev mode`);
  }
  assert.match(tagOf(html, "view-chat"), /aria-selected="true"/);
  assert.equal(countOf(html, 'data-testid="stage"'), 0, "no stage until a view asks for one");
  assert.match(tagOf(html, "composer-input"), /aria-label="Message the agent"/);
  assert.match(tagOf(html, "open-settings"), /aria-label="Settings"/);
});

test("run completion notices describe success duration and failures", async () => {
  installBrowserStubs();
  const { runCompletionToast, shouldToastRunCompletion } = await import("./App");
  assert.deepEqual(runCompletionToast("finished", { createdAt: 1_000, finishedAt: 8_000 }), {
    tone: "success",
    message: "Run finished in 7s.",
  });
  assert.deepEqual(runCompletionToast("error", { createdAt: 1_000, finishedAt: 8_000 }), {
    tone: "error",
    message: "Run failed — see the report.",
  });
  assert.equal(runCompletionToast("running", { createdAt: 1_000 }), null);
  assert.equal(
    shouldToastRunCompletion({ phase: "finished", wasActive: true, view: "board", alreadyNotified: false }),
    true,
  );
  assert.equal(
    shouldToastRunCompletion({ phase: "finished", wasActive: true, view: "chat", alreadyNotified: false }),
    false,
  );
  assert.equal(
    shouldToastRunCompletion({ phase: "error", wasActive: false, view: "screen", alreadyNotified: false }),
    false,
  );
  assert.equal(
    shouldToastRunCompletion({ phase: "finished", wasActive: true, view: "screen", alreadyNotified: true }),
    false,
  );
});

test("the live desktop tab is labelled Computer, never Screen", async () => {
  const html = await renderApp();
  const tab = /<button\b[^>]*data-testid="view-screen"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
  assert.match(tab, /Computer/, "the honest label for the live desktop");
  assert.doesNotMatch(tab, /Screen/, "no stale 'Screen' label on the tab");
  assert.doesNotMatch(html, />Screen</, "no user-visible 'Screen' label anywhere in the shell");
  assert.doesNotMatch(html, /Watch the screen/, "the hero copy agrees with the tab");
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
  const wide = await renderApp({ local: { "sa.view": "board", "sa.devMode": true }, wide: true });
  assert.equal(countOf(wide, 'data-testid="board-panel"'), 1);
  assert.doesNotMatch(tagOf(wide, "chat-column"), /hidden=""/);
  assert.match(tagOf(wide, "view-board"), /aria-selected="true"/);

  const phone = await renderApp({ local: { "sa.view": "board", "sa.devMode": true }, wide: false });
  assert.equal(countOf(phone, 'data-testid="board-panel"'), 1);
  assert.match(tagOf(phone, "chat-column"), /hidden=""/, "kept mounted so the draft survives, but out of view");
  for (const view of ["chat", "screen", "board"]) {
    assert.equal(countOf(phone, `data-testid="view-${view}"`), 1, `the way back to ${view} is still there`);
  }
});

test("the board stays hidden until dev mode is on", async () => {
  const gated = await renderApp({ local: { "sa.view": "board" }, wide: true });
  assert.match(tagOf(gated, "minimal-main-page"), /data-view="chat"/, "a saved board view falls back to chat");
  assert.equal(countOf(gated, 'data-testid="view-board"'), 0, "no board tab without dev mode");
  assert.equal(countOf(gated, 'data-testid="board-panel"'), 0, "no board panel without dev mode");

  const dev = await renderApp({ local: { "sa.view": "board", "sa.devMode": true }, wide: true });
  assert.match(tagOf(dev, "minimal-main-page"), /data-view="board"/);
  assert.equal(countOf(dev, 'data-testid="board-panel"'), 1);
});

test("nothing in the shell is a placeholder", async () => {
  for (const view of ["chat", "screen", "board"]) {
    const html = await renderApp({ local: { "sa.view": view }, wide: true });
    assert.doesNotMatch(html, /coming soon|not implemented|todo/i, view);
  }
});

test("the split view has a drag handle between the chat and the stage", async () => {
  const html = await renderApp({ local: { "sa.view": "screen" }, wide: true });
  assert.equal(countOf(html, 'data-testid="split-handle"'), 1, "one handle in split view");
  const handle = tagOf(html, "split-handle");
  assert.match(handle, /role="separator"/);
  assert.match(handle, /aria-orientation="vertical"/);
  assert.match(handle, /aria-valuenow="38"/, "the default ratio");
  assert.match(handle, /\bhidden\b/, "hidden below the wide breakpoint");
  assert.match(handle, /\blg:flex\b/, "shown at the wide breakpoint");
});

test("the split view sizes the chat from the persisted ratio, with a 480px floor", async () => {
  const html = await renderApp({ local: { "sa.view": "screen" }, wide: true });
  assert.match(
    tagOf(html, "chat-column"),
    /width:clamp\(480px, 38\.0%, calc\(100% - 492px\)\)/,
    "the default ratio drives the chat width",
  );

  const half = await renderApp({ local: { "sa.view": "board", "sa.devMode": true, "sa.splitRatio": 0.5 }, wide: true });
  assert.equal(countOf(half, 'data-testid="split-handle"'), 1, "the handle is there for the board too");
  assert.match(tagOf(half, "chat-column"), /width:clamp\(480px, 50\.0%, calc\(100% - 492px\)\)/);
  assert.match(tagOf(half, "split-handle"), /aria-valuenow="50"/, "the persisted ratio survives a reload");
});

test("an out-of-range persisted ratio is clamped, never trusted", async () => {
  const tooWide = await renderApp({ local: { "sa.view": "screen", "sa.splitRatio": 0.99 }, wide: true });
  assert.match(tagOf(tooWide, "chat-column"), /width:clamp\(480px, 80\.0%, calc\(100% - 492px\)\)/);
  assert.match(tagOf(tooWide, "split-handle"), /aria-valuenow="80"/);

  const junk = await renderApp({ local: { "sa.view": "screen", "sa.splitRatio": "junk" }, wide: true });
  assert.match(tagOf(junk, "chat-column"), /width:clamp\(480px, 38\.0%, calc\(100% - 492px\)\)/, "junk falls back to the default");
});

test("no split handle when the chat is alone, or on a narrow screen", async () => {
  const chatOnly = await renderApp({ local: { "sa.view": "chat" }, wide: true });
  assert.equal(countOf(chatOnly, 'data-testid="split-handle"'), 0, "no stage, no handle");
  assert.doesNotMatch(tagOf(chatOnly, "chat-column"), /width:clamp/, "the chat takes the full row");

  const phone = await renderApp({ local: { "sa.view": "screen" }, wide: false });
  assert.equal(countOf(phone, 'data-testid="split-handle"'), 0, "a phone stays a single pane");
  assert.doesNotMatch(tagOf(phone, "chat-column"), /width:clamp/, "no fixed width on a phone");
});
