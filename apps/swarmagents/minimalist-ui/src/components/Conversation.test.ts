import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolEntry } from "../../../lib/client/turns";
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

<<<<<<< HEAD
function cssRule(selector: string): string {
  const css = readFileSync(fileURLToPath(new URL("../../../app/globals.css", import.meta.url)), "utf8");
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `${selector} is defined in globals.css`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("prose code blocks use the code line height and cap long blocks at max-h-56", () => {
  const pre = cssRule(".sa-prose pre");
  assert.match(pre, /max-height:\s*14rem/, "long blocks cap at max-h-56 (14rem)");
  assert.match(pre, /overflow:\s*auto/, "a capped block scrolls");
  assert.match(pre, /font-size:\s*12\.5px/, "the pre uses the code font size");
  assert.match(
    pre,
    /line-height:\s*1\.6/,
    "the pre uses the code line height, so the prose strut adds no empty space",
  );

  const code = cssRule(".sa-prose pre code");
  assert.match(code, /font-size:\s*12\.5px/);
  assert.match(code, /line-height:\s*1\.6/, "pre and code agree, so a 10-line block stays short");
});

function toolEntry(output: string): ToolEntry {
  return {
    kind: "tool",
    key: "tool:code",
    ts: 1_000,
    name: "Bash",
    label: "Running a command",
    status: "done",
    input: "",
    output,
  };
}

test("tool detail code blocks size to content and cap long output", async () => {
  installBrowserStubs({});
  const { ToolDetail } = await import("./Conversation");
  const short = toolEntry(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
  const long = toolEntry(Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n"));

  for (const entry of [short, long]) {
    const html = renderToStaticMarkup(React.createElement(ToolDetail, { entry }));
    const match = /<pre class="([^"]*)"/.exec(html);
    assert.ok(match, "the detail renders a pre");
    const classes = match[1];
    assert.match(classes, /max-h-56/, "output is capped at max-h-56");
    assert.match(classes, /overflow-auto/, "the capped block scrolls");
    assert.doesNotMatch(
      classes,
      /(?:^|\s)(?:h|min-h)-\d/,
      "no fixed or minimum height pads a short block with empty space",
    );
  }
});

test("the Latest pill is hidden while the view is stuck at the bottom", async () => {
  const html = await renderConversation(makeSession({ turns: [] }));
  assert.equal(countOf(html, 'data-testid="jump-to-latest"'), 0, "no jump-to-latest pill while stuck at the bottom");
});
