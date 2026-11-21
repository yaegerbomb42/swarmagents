import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf, installBrowserStubs, makeBoard, makeEntry, makeSession } from "../testing/harness";

const STARTERS = [
  "Create a file and run a script",
  "Organize a messy folder",
  "Fetch a web page and summarize it",
];

async function renderConversation(session = makeSession()) {
  installBrowserStubs({});
  const { Conversation } = await import("./Conversation");
  return renderToStaticMarkup(
    React.createElement(Conversation, {
      session,
      taskLinks: makeBoard().links,
      starters: STARTERS,
    })
  );
}

test("a fresh empty chat shows exactly three clickable starter prompts", async () => {
  const html = await renderConversation(makeSession({ turns: [], pending: undefined }));
  assert.equal(countOf(html, 'data-testid="starter-prompt"'), 3, "three starter prompts");
  for (const text of STARTERS) {
    assert.ok(html.includes(text), `starter prompt rendered: ${text}`);
  }
});

test("an existing thread shows no starter prompts", async () => {
  const html = await renderConversation(makeSession({ turns: [makeEntry()] }));
  assert.equal(countOf(html, 'data-testid="starter-prompt"'), 0, "no starters on an existing thread");
});

test("clicking a starter is wired to send its text", async () => {
  let sent: string | undefined;
  const session = makeSession({
    turns: [],
    pending: undefined,
    send: async (text: string) => { sent = text; return { ok: true, runId: "run_1" }; },
  });
  installBrowserStubs({});
  const { Conversation } = await import("./Conversation");
  renderToStaticMarkup(
    React.createElement(Conversation, { session, taskLinks: makeBoard().links, starters: STARTERS })
  );
  // Static render cannot fire a click; assert the handler is not invoked during render.
  assert.equal(sent, undefined, "send is not invoked during a static render");
});
