import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf, installBrowserStubs, tagOf } from "../testing/harness";
import { BrowserFrameImage, BrowserLoadStatus, BrowserView, STILL_WAITING_MS, frameFetchInFlight, hasWaitedLongEnough } from "./BrowserView";

/**
 * The browser chrome's under-address-bar hint has two jobs that used to be
 * conflated: show progress while a frame is really being fetched, and stop
 * looking stuck once the poll has settled into "No frame yet". The decision is
 * split into pure helpers plus a tiny presentational component so both halves
 * can be checked with a static render (no timers, no DOM).
 */

test("the loading bar is reserved for an in-flight first-frame fetch", () => {
  const run = "run_1";
  // The hook sets "polling" before the first request resolves, then "empty"
  // on a clean 404 ("No frame yet") or "error" on a real failure.
  assert.equal(frameFetchInFlight(run, { status: "polling" }), true, "fetch outstanding, no frame");
  assert.equal(frameFetchInFlight(run, { status: "empty" }), false, "404 'No frame yet' is settled, not loading");
  assert.equal(frameFetchInFlight(run, { status: "error" }), false, "a failed fetch is settled");
  assert.equal(frameFetchInFlight(run, { status: "idle" }), false, "idle hook is not fetching");
  assert.equal(
    frameFetchInFlight(run, { status: "polling", frameUrl: "blob:frame" }),
    false,
    "a frame is already on screen",
  );
  assert.equal(frameFetchInFlight(undefined, { status: "polling" }), false, "no run, no fetch");
});

test("the 'Still waiting…' hint only trips after the 10s idle threshold", () => {
  assert.equal(STILL_WAITING_MS, 10_000);
  assert.equal(hasWaitedLongEnough(0), false);
  assert.equal(hasWaitedLongEnough(STILL_WAITING_MS - 1), false);
  assert.equal(hasWaitedLongEnough(STILL_WAITING_MS), true);
  assert.equal(hasWaitedLongEnough(STILL_WAITING_MS + 5_000), true);
});

test("the status strip renders a bar only for a real fetch, text only when idle", () => {
  installBrowserStubs();
  const h = React.createElement;

  const fetching = renderToStaticMarkup(h(BrowserLoadStatus, { fetching: true, stillWaiting: false }));
  assert.equal(countOf(fetching, 'data-testid="browser-loading-bar"'), 1, "bar during a fetch");
  assert.equal(countOf(fetching, 'role="progressbar"'), 1);
  assert.equal(countOf(fetching, "Still waiting…"), 0, "no idle text while fetching");

  const idle = renderToStaticMarkup(h(BrowserLoadStatus, { fetching: false, stillWaiting: true }));
  assert.equal(countOf(idle, 'data-testid="browser-loading-bar"'), 0, "no stuck bar once settled");
  assert.equal(countOf(idle, 'data-testid="browser-still-waiting"'), 1);
  assert.match(idle, /Still waiting…/, "honest idle hint");

  const normal = renderToStaticMarkup(h(BrowserLoadStatus, { fetching: false, stillWaiting: false }));
  assert.equal(countOf(normal, 'data-testid="browser-loading-bar"'), 0);
  assert.equal(countOf(normal, "Still waiting…"), 0, "nothing before the threshold");

  const both = renderToStaticMarkup(h(BrowserLoadStatus, { fetching: true, stillWaiting: true }));
  assert.equal(countOf(both, 'data-testid="browser-loading-bar"'), 1, "a live fetch wins over the idle text");
  assert.equal(countOf(both, "Still waiting…"), 0);
});

test("browser empty states explain what the user will see", () => {
  installBrowserStubs();
  const h = React.createElement;
  const idle = renderToStaticMarkup(h(BrowserView, {}));
  assert.match(idle, /The desktop frame appears once a run opens a page/);
  const afterRun = renderToStaticMarkup(h(BrowserView, { runId: "run_1" }));
  assert.match(afterRun, /The desktop frame appears once a run opens a page/);
});

test("the live page crossfades between frames instead of flashing", () => {
  installBrowserStubs();
  const h = React.createElement;

  const first = renderToStaticMarkup(h(BrowserFrameImage, { frameUrl: "blob:frame-1" }));
  assert.equal(countOf(first, 'data-testid="browser-frame-current"'), 1);
  assert.equal(countOf(first, 'data-testid="browser-frame-previous"'), 0, "no previous frame on the first paint");
  assert.match(tagOf(first, "browser-frame-current"), /opacity-100/, "the first frame is fully visible at once");

  const swap = renderToStaticMarkup(
    h(BrowserFrameImage, { frameUrl: "blob:frame-2", previousFrameUrl: "blob:frame-1" }),
  );
  assert.equal(countOf(swap, 'data-testid="browser-frame-previous"'), 1, "the old frame stays painted underneath");
  assert.equal(countOf(swap, 'data-testid="browser-frame-current"'), 1);
  assert.match(tagOf(swap, "browser-frame-current"), /opacity-0/, "the new frame starts transparent until it loads");
  assert.match(tagOf(swap, "browser-frame-current"), /transition-opacity duration-300/, "the fade is a 300ms opacity transition");

  const same = renderToStaticMarkup(
    h(BrowserFrameImage, { frameUrl: "blob:frame-1", previousFrameUrl: "blob:frame-1" }),
  );
  assert.equal(countOf(same, 'data-testid="browser-frame-previous"'), 0, "an unchanged URL is not its own previous frame");
});
