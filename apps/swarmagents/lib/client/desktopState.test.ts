import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_DESKTOP_CONN,
  MAX_DESKTOP_ATTEMPTS,
  desktopBackoffMs,
  reduceDesktopConn,
} from "./desktopState";

const BOOTED = reduceDesktopConn(INITIAL_DESKTOP_CONN, { type: "vm-ready" });
const LIVE = reduceDesktopConn(BOOTED, { type: "open" });

test("boot sequence: starting → connecting → live", () => {
  assert.equal(INITIAL_DESKTOP_CONN.phase, "starting");

  const connecting = reduceDesktopConn(INITIAL_DESKTOP_CONN, { type: "vm-ready" });
  assert.equal(connecting.phase, "connecting");
  assert.equal(connecting.attempt, 0);
  assert.equal(connecting.retryInMs, 0);

  const live = reduceDesktopConn(connecting, { type: "open" });
  assert.equal(live.phase, "live");
  assert.equal(live.sawLive, true);
  assert.equal(live.attempt, 0);
});

test("a live socket is never downgraded by a late vm-starting event", () => {
  assert.equal(reduceDesktopConn(LIVE, { type: "vm-starting" }).phase, "live");
});

test("drop from live enters reconnecting with the first backoff delay", () => {
  const re = reduceDesktopConn(LIVE, { type: "drop" });
  assert.equal(re.phase, "reconnecting");
  assert.equal(re.attempt, 1);
  assert.equal(re.retryInMs, desktopBackoffMs(1));
  assert.equal(re.sawLive, true, "LIVE was seen, so the indicator stays until offline");
});

test("reconnect walks the backoff schedule and eventually goes offline", () => {
  let s = reduceDesktopConn(LIVE, { type: "drop" });
  let drops = 1;
  while (s.phase === "reconnecting") {
    const due = reduceDesktopConn(s, { type: "retry-due" });
    assert.equal(due.phase, "connecting");
    assert.equal(due.retryInMs, 0);
    s = reduceDesktopConn(due, { type: "drop" });
    drops += 1;
  }
  assert.equal(s.attempt, MAX_DESKTOP_ATTEMPTS);
  assert.equal(s.phase, "offline");
  assert.ok(drops >= MAX_DESKTOP_ATTEMPTS - 1);
});

test("retry-due is a no-op outside the reconnecting phase", () => {
  assert.equal(reduceDesktopConn(LIVE, { type: "retry-due" }), LIVE);
  assert.equal(reduceDesktopConn(INITIAL_DESKTOP_CONN, { type: "retry-due" }), INITIAL_DESKTOP_CONN);
});

test("refused dials (desktop mode off) fall back to offline without a frame", () => {
  const off = reduceDesktopConn(BOOTED, { type: "refused" });
  assert.equal(off.phase, "offline");
  assert.equal(off.hasFrame, false);
});

test("offline fallback keeps the latest screenshot frame when one arrives", () => {
  let s = reduceDesktopConn(LIVE, { type: "refused" });
  s = reduceDesktopConn(s, { type: "fallback-frame" });
  assert.equal(s.phase, "offline");
  assert.equal(s.hasFrame, true);
  // A later failed dial attempt reports "nothing to show".
  s = reduceDesktopConn(s, { type: "no-frame" });
  assert.equal(s.hasFrame, false);
});

test("retry-now resets the backoff budget and dials immediately", () => {
  const off = reduceDesktopConn(LIVE, { type: "refused" });
  const retry = reduceDesktopConn(off, { type: "retry-now" });
  assert.equal(retry.phase, "connecting");
  assert.equal(retry.attempt, 0);
  assert.equal(retry.retryInMs, 0);
  assert.equal(retry.hasFrame, false);
});

test("backoff increases and caps", () => {
  assert.ok(desktopBackoffMs(1) < desktopBackoffMs(2));
  assert.ok(desktopBackoffMs(2) <= desktopBackoffMs(3));
  assert.equal(desktopBackoffMs(50), 30_000, "capped at the 30s schedule ceiling");
});

test("vm-starting during boot keeps the screen in the starting phase", () => {
  const s1 = reduceDesktopConn(INITIAL_DESKTOP_CONN, { type: "vm-starting" });
  assert.equal(s1.phase, "starting");
  // Clearing out of starting still works once the VM reports ready.
  assert.equal(reduceDesktopConn(s1, { type: "vm-ready" }).phase, "connecting");
});
