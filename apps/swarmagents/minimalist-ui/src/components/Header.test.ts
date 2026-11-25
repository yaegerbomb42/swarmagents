import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf, installBrowserStubs, tagOf } from "../testing/harness";
import type { HeaderProps, WorkspaceView } from "./Header";
import type { SegmentOption } from "./ui";

/**
 * The auth pill, rendered as the server would send it: a guest sees
 * "Sign in", a signed-in user sees their account, and the pill is present
 * at every width — it is never hidden below sm the way the shortcuts
 * button is.
 */
async function renderHeader(me: HeaderProps["me"]): Promise<string> {
  installBrowserStubs({});
  const { Header } = await import("./Header");
  const views: SegmentOption<WorkspaceView>[] = [
    { id: "chat", label: "Chat" },
    { id: "screen", label: "Computer" },
  ];
  return renderToStaticMarkup(
    React.createElement(Header, {
      title: "New chat",
      onOpenHistory: () => {},
      onNewChat: () => {},
      newChatDisabled: false,
      views,
      view: "screen",
      onView: () => {},
      wide: false,
      run: { phase: null, stopping: false, onStop: () => {}, onShow: () => {} },
      onOpenSettings: () => {},
      settingsNeedsAttention: false,
      onOpenShortcuts: () => {},
      me,
    }),
  );
}

test("a signed-out visitor gets a Sign in pill that links to /login", async () => {
  const html = await renderHeader(null);
  assert.equal(countOf(html, 'data-testid="auth-pill"'), 1);
  const pill = tagOf(html, "auth-pill");
  assert.match(pill, /data-auth="signed-out"/);
  assert.match(pill, /href="\/login"/);
  assert.match(html, /Sign in/);
});

test("a signed-in user gets an Account pill with their email's local part", async () => {
  const html = await renderHeader({ id: "u1", email: "alice@example.com" });
  assert.equal(countOf(html, 'data-testid="auth-pill"'), 1);
  const pill = tagOf(html, "auth-pill");
  assert.match(pill, /data-auth="signed-in"/);
  assert.match(pill, /title="alice@example.com"/);
  assert.match(html, /alice/);
  assert.match(html, />A</, "the pill carries the account initial");
});

test("the pill renders nothing while the session is still loading", async () => {
  const html = await renderHeader(undefined);
  assert.equal(countOf(html, 'data-testid="auth-pill"'), 0, "no Sign in flash for a signed-in user");
});

test("the auth pill is visible at mobile widths; the shortcuts button tucks away instead", async () => {
  for (const me of [null, { id: "u1", email: "alice@example.com" }] as const) {
    const html = await renderHeader(me);
    const pill = tagOf(html, "auth-pill");
    assert.doesNotMatch(pill, /hidden/, "the pill must never be hidden below sm");
    assert.doesNotMatch(pill, /sm:/, "the pill needs no breakpoint-gated display");
  }
  const html = await renderHeader(null);
  assert.match(tagOf(html, "open-shortcuts"), /hidden/, "shortcuts hide below sm to keep the top-right clean");
  assert.match(tagOf(html, "open-shortcuts"), /sm:grid/, "shortcuts return at sm and up");
});

test("accountLabel falls back to Account without an email", async () => {
  installBrowserStubs({});
  const { accountLabel } = await import("./Header");
  assert.equal(accountLabel({ id: "u1", email: "alice@example.com" }), "alice");
  assert.equal(accountLabel({ id: "u1", email: null }), "Account");
  assert.equal(accountLabel({ id: "u1" }), "Account");
  assert.equal(accountLabel({ id: "u1", email: "  " }), "Account");
});
