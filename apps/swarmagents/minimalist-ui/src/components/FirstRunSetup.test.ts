import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf, installBrowserStubs, tagOf } from "../testing/harness";

/**
 * FIX-43: a zero-provider account's first screen is the setup prompt, and
 * the composer is blocked with the reason — no run error is reachable. An
 * account with a provider gets the normal composer. The decision of when
 * each shows is `firstRunSetup` (tested in hooks/session.test.ts); these
 * tests pin what each state renders.
 */

test("the first-run setup prompt leads to adding a key", async () => {
  installBrowserStubs();
  const { FirstRunSetup } = await import("./FirstRunSetup");
  const html = renderToStaticMarkup(React.createElement(FirstRunSetup, { onOpenProviders: () => {} }));

  assert.equal(countOf(html, 'data-testid="first-run-setup"'), 1, "the setup state renders");
  assert.match(html, /Add a provider key to run your first task/, "the heading names the one next step");
  assert.match(html, /BYOK/, "it says why a key is needed");
  assert.equal(countOf(html, 'data-testid="first-run-add-provider"'), 1, "one call to action");
  assert.match(html, />Add provider key</, "the button opens provider setup");
  assert.doesNotMatch(html, /State the outcome/, "the marketing hero is replaced, not stacked");
});

test("with no provider the composer is blocked, so no run can error", async () => {
  installBrowserStubs();
  const { Composer } = await import("./Composer");
  const html = renderToStaticMarkup(
    React.createElement(Composer, {
      value: "",
      onChange: () => {},
      onSend: async () => ({ ok: true as const }),
      blockedReason: "Add a provider key to send",
    }),
  );

  const input = tagOf(html, "composer-input");
  assert.match(input, /disabled=""/, "the input is disabled");
  assert.match(input, /placeholder="Add a provider key to send"/, "the reason is where the user would type");
  assert.match(tagOf(html, "composer-send"), /disabled=""/, "send is disabled");
  assert.match(tagOf(html, "attach-button"), /disabled=""/, "attach is disabled too");
});

test("with a provider the composer is the normal one", async () => {
  installBrowserStubs();
  const { Composer } = await import("./Composer");
  const html = renderToStaticMarkup(
    React.createElement(Composer, {
      value: "hello",
      onChange: () => {},
      onSend: async () => ({ ok: true as const }),
    }),
  );

  const input = tagOf(html, "composer-input");
  assert.doesNotMatch(input, /disabled=""/, "the input accepts text");
  assert.match(input, /placeholder="Message the agent"/, "the normal placeholder");
  assert.doesNotMatch(tagOf(html, "composer-send"), /disabled=""/, "a typed message can send");
});
