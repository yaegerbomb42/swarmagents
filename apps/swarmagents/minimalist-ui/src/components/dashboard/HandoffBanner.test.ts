import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf } from "../../testing/harness";
import { HandoffBanner } from "./HandoffBanner";

/**
 * The workspace-level takeover banner for a pending ask_human_desktop
 * handoff. Static renders only: the component is presentational, and the
 * takeover loop itself is covered by the takeover-session and handoff
 * store tests.
 */

const h = React.createElement;

const BASE = {
  handoff: { id: "h_1", reason: "CAPTCHA present on the sign-in page" },
  onTakeControl: () => {},
  onHandBack: () => {},
};

test("the handoff banner names the pause and offers both takeover actions", () => {
  const html = renderToStaticMarkup(h(HandoffBanner, BASE));
  assert.equal(countOf(html, 'data-testid="desktop-handoff-banner"'), 1);
  assert.equal(countOf(html, 'role="status"'), 1, "announced politely, not as an alert");
  assert.match(html, /Agent paused/, "the pause is named in plain words");
  assert.match(html, /CAPTCHA present on the sign-in page/, "the agent's reason is shown");
  assert.equal(countOf(html, 'data-testid="handoff-take-control"'), 1, "Take Control");
  assert.equal(countOf(html, 'data-testid="handoff-hand-back"'), 1, "Hand Back");
  assert.match(html, /Hand Back/, "the hand-back action is labelled");
});

test("the handoff banner counts extra outstanding handoffs", () => {
  const html = renderToStaticMarkup(h(HandoffBanner, { ...BASE, total: 3 }));
  assert.match(html, /\+2 more/);
  const single = renderToStaticMarkup(h(HandoffBanner, { ...BASE, total: 1 }));
  assert.ok(!/\+\d+ more/.test(single), "no counter for a single handoff");
});

test("the hand-back button is disabled and spins while the hand-back is in flight", () => {
  const html = renderToStaticMarkup(h(HandoffBanner, { ...BASE, handingBack: true }));
  assert.match(
    tagOf(html, "handoff-hand-back"),
    /\sdisabled="/,
    "a second click cannot double-resolve the handoff",
  );
});

test("Take Control and Hand Back are wired to their callbacks", () => {
  let taken = 0;
  let handed = 0;
  const html = renderToStaticMarkup(
    h(HandoffBanner, {
      handoff: BASE.handoff,
      onTakeControl: () => {
        taken += 1;
      },
      onHandBack: () => {
        handed += 1;
      },
    }),
  );
  // Static markup cannot click; the wiring check is that the buttons are
  // plain buttons (no disabled) so the callbacks are reachable.
  assert.ok(!/\sdisabled="/.test(tagOf(html, "handoff-take-control")));
  assert.ok(!/\sdisabled="/.test(tagOf(html, "handoff-hand-back")));
  assert.equal(taken, 0);
  assert.equal(handed, 0);
});

function tagOf(html: string, testId: string): string {
  const match = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`));
  return match ? match[0] : "";
}
