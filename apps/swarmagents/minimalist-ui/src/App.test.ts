import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf, installBrowserStubs, tagOf, type BrowserStubOptions } from "./testing/harness";

/**
 * The new shell, rendered as the server would send it: the full-bleed
 * desktop above one composer, with a single settings icon at the top
 * right. The conversation and the board are slide-over panels, not tabs.
 */
async function renderApp(options: BrowserStubOptions = {}): Promise<string> {
  installBrowserStubs(options);
  const { default: App } = await import("./App");
  const { ToastsProvider } = await import("./components/Toasts");
  return renderToStaticMarkup(React.createElement(ToastsProvider, null, React.createElement(App)));
}

const ALWAYS_IN_REACH = ["open-settings", "open-conversation", "composer-input", "composer-send"];

test("the workspace is the computer above one composer, and nothing else", async () => {
  const html = await renderApp();

  // The three components are the only top-level UI: no header bar, no view
  // tabs, no brand lockup, no hero.
  assert.equal(countOf(html, 'data-testid="workspace-header"'), 0, "no header bar");
  assert.equal(countOf(html, 'data-testid="workspace-topbar"'), 1, "one slim top strip");
  assert.equal(countOf(html, 'data-testid="brand-lockup"'), 0, "no brand lockup");
  assert.equal(countOf(html, 'data-testid="workspace-hero"'), 0, "no hero");
  for (const view of ["chat", "screen", "board"]) {
    assert.equal(countOf(html, `data-testid="view-${view}"`), 0, `no ${view} tab`);
  }
  for (const id of ALWAYS_IN_REACH) assert.equal(countOf(html, `data-testid="${id}"`), 1, id);
  assert.equal(countOf(html, 'data-testid="stage"'), 1);
  assert.ok(html.indexOf('data-testid="screen-frame"') < html.indexOf('data-testid="composer-input"'));
  assert.match(tagOf(html, "composer-input"), /aria-label="Message the agent"/);
  assert.match(tagOf(html, "open-settings"), /aria-label="Settings"/);
  // Full-bleed stage: no rounded card, no max-width, no padding.
  assert.doesNotMatch(tagOf(html, "stage"), /rounded-\[28px\]/);
  assert.doesNotMatch(tagOf(html, "stage"), /max-w-7xl/);
  assert.match(tagOf(html, "stage"), /overflow-hidden/);
  // Narrow-viewport clearance: the composer section keeps extra bottom
  // padding below sm and the composer's action row keeps extra bottom
  // padding inside the glass box, so the bottom-left Attach button never
  // sits flush to the viewport edge (or anything anchored to it) on a phone.
  assert.match(tagOf(html, "composer-section"), /pb-5/);
  assert.match(tagOf(html, "composer-actions"), /pb-2/);
  // Before the first run the desktop area is one quiet line and a launch
  // button, not a hero.
  assert.equal(countOf(html, 'data-testid="desktop-empty"'), 1);
  assert.equal(countOf(html, 'data-testid="launch-desktop-btn"'), 1);
  // The conversation toggle's history and new-chat controls live inside the
  // (closed) panel, not in the shell.
  assert.equal(countOf(html, 'data-testid="open-history"'), 0);
  assert.equal(countOf(html, 'data-testid="new-chat"'), 0);
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
    shouldToastRunCompletion({ phase: "finished", wasActive: true, chatOpen: false, alreadyNotified: false }),
    true,
  );
  assert.equal(
    shouldToastRunCompletion({ phase: "finished", wasActive: true, chatOpen: true, alreadyNotified: false }),
    false,
  );
  assert.equal(
    shouldToastRunCompletion({ phase: "error", wasActive: false, chatOpen: false, alreadyNotified: false }),
    false,
  );
  assert.equal(
    shouldToastRunCompletion({ phase: "finished", wasActive: true, chatOpen: false, alreadyNotified: true }),
    false,
  );
});

test("the desktop is the only main view: no tab labels, the conversation is a panel", async () => {
  const html = await renderApp();
  assert.doesNotMatch(html, />Screen</, "no user-visible 'Screen' label anywhere in the shell");
  assert.doesNotMatch(html, /Watch the screen/, "no stale 'Watch the screen' copy");
  assert.equal(countOf(html, 'data-testid="conversation-panel"'), 0, "the conversation panel starts closed");

  const open = await renderApp({ local: { "sa.chatOpen": true } });
  assert.equal(countOf(open, 'data-testid="conversation-panel"'), 1, "the panel opens from its persisted state");
  assert.equal(countOf(open, 'data-testid="open-history"'), 1, "history lives in the panel header");
  assert.equal(countOf(open, 'data-testid="new-chat"'), 1, "new chat lives in the panel header");
  assert.match(open, /Connecting to autonomous swarm/, "the panel loads the conversation");

  const boardClosed = await renderApp({ local: { "sa.boardOpen": true } });
  assert.equal(countOf(boardClosed, 'data-testid="board-panel"'), 0, "no board panel without dev mode");
  const dev = await renderApp({ local: { "sa.devMode": true, "sa.boardOpen": true }, wide: true });
  assert.equal(countOf(dev, 'data-testid="board-panel"'), 1, "the board panel opens in dev mode");
});

test("the approval prompt's layer is mounted", async () => {
  const html = await renderApp();
  assert.equal(countOf(html, 'data-testid="approval-layer"'), 1);
});

test("the computer sits above the composer with its status", async () => {
  for (const wide of [false, true]) {
    const html = await renderApp({ wide });

    for (const id of ["stage", "screen-frame", "screen-toolbar", "screen-status-pill", "screen-stage"]) {
      assert.equal(countOf(html, `data-testid="${id}"`), 1, `${id} (wide: ${wide})`);
    }
    assert.equal(countOf(html, 'data-testid="workspace-activity"'), 1);
    for (const id of ALWAYS_IN_REACH) assert.equal(countOf(html, `data-testid="${id}"`), 1, id);
    // No run is active in a static render, so there is no Stop button yet.
    assert.equal(countOf(html, 'data-testid="stop-run"'), 0, `no Stop without a run (wide: ${wide})`);
  }
});

test("the board stays hidden until dev mode is on", async () => {
  const gated = await renderApp({ local: { "sa.boardOpen": true }, wide: true });
  assert.equal(countOf(gated, 'data-testid="board-panel"'), 0, "no board panel without dev mode");

  const dev = await renderApp({ local: { "sa.boardOpen": true, "sa.devMode": true }, wide: true });
  assert.equal(countOf(dev, 'data-testid="board-panel"'), 1);
});

test("nothing in the shell is a placeholder", async () => {
  const html = await renderApp({ wide: true });
  assert.doesNotMatch(html, /coming soon|not implemented|todo/i);
});

test("the composer stays pinned below the workspace at desktop and phone widths", async () => {
  for (const wide of [false, true]) {
    const html = await renderApp({ wide });
    assert.match(tagOf(html, "workspace-main"), /overflow-hidden/);
    assert.match(tagOf(html, "stage"), /overflow-hidden/);
    assert.ok(html.indexOf('data-testid="stage"') < html.indexOf('data-testid="composer-input"'));
    assert.equal(countOf(html, 'data-testid="split-handle"'), 0);
  }
});

test("keyboard shortcuts live in settings; the help panel starts closed", async () => {
  const html = await renderApp();
  assert.equal(countOf(html, 'data-testid="open-shortcuts"'), 0, "no '?' button in the shell");
  assert.equal(countOf(html, 'data-testid="shortcuts-help"'), 0, "the help panel is closed by default");
  assert.equal(countOf(html, 'data-testid="settings-sheet"'), 0, "settings starts closed");
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
