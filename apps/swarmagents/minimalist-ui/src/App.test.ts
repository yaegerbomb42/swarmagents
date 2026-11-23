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

const ALWAYS_IN_REACH = ["workspace-header", "open-history", "new-chat", "open-settings", "open-shortcuts", "composer-input", "composer-send"];

test("the workspace opens on the computer beneath one composer", async () => {
  const html = await renderApp();

  assert.match(tagOf(html, "minimal-main-page"), /data-view="screen"/);
  for (const id of ALWAYS_IN_REACH) assert.equal(countOf(html, `data-testid="${id}"`), 1, id);
  for (const view of ["chat", "screen"]) {
    assert.equal(countOf(html, `data-testid="view-${view}"`), 1, `one ${view} tab`);
  }
  assert.equal(countOf(html, 'data-testid="view-board"'), 0, "no board tab without dev mode");
  const dev = await renderApp({ local: { "sa.devMode": true } });
  for (const view of ["chat", "screen", "board"]) {
    assert.equal(countOf(dev, `data-testid="view-${view}"`), 1, `one ${view} tab in dev mode`);
  }
  assert.match(tagOf(html, "view-screen"), /aria-selected="true"/);
  assert.equal(countOf(html, 'data-testid="stage"'), 1);
  assert.ok(html.indexOf('data-testid="composer-input"') < html.indexOf('data-testid="screen-frame"'));
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

test("the screen view puts the computer below the composer with its status", async () => {
  for (const wide of [false, true]) {
    const html = await renderApp({ local: { "sa.view": "screen" }, wide });

    assert.match(tagOf(html, "minimal-main-page"), /data-view="screen"/);
    assert.match(tagOf(html, "view-screen"), /aria-selected="true"/);
    for (const id of ["stage", "screen-frame", "screen-toolbar", "screen-status-pill", "screen-stage"]) {
      assert.equal(countOf(html, `data-testid="${id}"`), 1, `${id} (wide: ${wide})`);
    }
    assert.equal(countOf(html, 'data-testid="workspace-activity"'), 1);
    for (const id of ALWAYS_IN_REACH) assert.equal(countOf(html, `data-testid="${id}"`), 1, id);
  }
});

test("board and chat keep the composer and computer mounted at every width", async () => {
  for (const wide of [false, true]) {
    for (const view of ["chat", "board"]) {
      const html = await renderApp({ local: { "sa.view": view, "sa.devMode": true }, wide });
      assert.equal(countOf(html, 'data-testid="screen-frame"'), 1);
      assert.equal(countOf(html, 'data-testid="composer-input"'), 1);
      assert.match(tagOf(html, `view-${view}`), /aria-selected="true"/);
    }
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

test("the composer stays above the workspace at desktop and phone widths", async () => {
  for (const wide of [false, true]) {
    const html = await renderApp({ local: { "sa.view": "screen" }, wide });
    assert.match(tagOf(html, "workspace-main"), /overflow-hidden/);
    assert.match(tagOf(html, "stage"), /overflow-y-auto/);
    assert.ok(html.indexOf('data-testid="composer-input"') < html.indexOf('data-testid="stage"'));
    assert.equal(countOf(html, 'data-testid="split-handle"'), 0);
  }
});

test("the header has a keyboard-shortcuts help button; the panel starts closed", async () => {
  const html = await renderApp();
  assert.equal(countOf(html, 'data-testid="open-shortcuts"'), 1, "one '?' help button");
  assert.match(tagOf(html, "open-shortcuts"), /aria-label="Keyboard shortcuts"/);
  assert.equal(countOf(html, 'data-testid="shortcuts-help"'), 0, "the help panel is closed by default");
});

test("workspace chords map to focus and new chat, never bare keys", async () => {
  const { workspaceChordAction } = await import("./App");

  assert.deepEqual(workspaceChordAction({ key: "k", metaKey: true }), "focusComposer");
  assert.deepEqual(workspaceChordAction({ key: "K", ctrlKey: true }), "focusComposer");
  assert.deepEqual(workspaceChordAction({ key: "o", metaKey: true, shiftKey: true }), "newChat");
  assert.deepEqual(workspaceChordAction({ key: "O", ctrlKey: true, shiftKey: true }), "newChat");

  // Plain Ctrl+O (browser open file), bare keys, and other chords are untouched.
  assert.equal(workspaceChordAction({ key: "o", ctrlKey: true }), null);
  assert.equal(workspaceChordAction({ key: "o", metaKey: true }), null);
  assert.equal(workspaceChordAction({ key: "o", shiftKey: true }), null);
  assert.equal(workspaceChordAction({ key: "k" }), null);
  assert.equal(workspaceChordAction({ key: "Escape" }), null);
  assert.equal(workspaceChordAction({ key: "a", metaKey: true }), null);
});

test("an unanswered provider status never shows the setup wall (FIX-43)", async () => {
  // Effects do not run in a static render, so useProviderStatus stays
  // "unknown" here — the same state a configured account sees for one
  // round-trip on load. The setup prompt and the blocked composer are
  // reserved for a confirmed "missing" (see firstRunSetup's tests).
  const html = await renderApp();
  assert.equal(countOf(html, 'data-testid="first-run-setup"'), 0, "no setup prompt on a guess");
  assert.equal(countOf(html, 'data-testid="provider-notice"'), 0, "no provider notice on a guess");
  assert.doesNotMatch(tagOf(html, "composer-input"), /disabled=""/, "the composer is not blocked on a guess");
});
