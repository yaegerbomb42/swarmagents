import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_FRAME_HEIGHT,
  DESKTOP_FRAME_WIDTH,
  DESKTOP_SCREENSHOT_PATH,
  DESKTOP_WS_PATH,
  desktopWsUrl,
} from "./desktopConfig";

const LOC = { protocol: "https:", host: "swarmagents.codes" };

test("desktop websocket URL is same-origin and hits the d2 proxy path", () => {
  const url = desktopWsUrl("view", LOC);
  assert.equal(url, "wss://swarmagents.codes/desktop/ws?mode=view");
});

test("mode switching maps view and control to the wire modes", () => {
  assert.equal(desktopWsUrl("view", LOC), "wss://swarmagents.codes/desktop/ws?mode=view");
  assert.equal(desktopWsUrl("control", LOC), "wss://swarmagents.codes/desktop/ws?mode=control");
});

test("plain http uses ws:// so local dev connects without TLS", () => {
  const url = desktopWsUrl("control", { protocol: "http:", host: "localhost:3000" });
  assert.equal(url, "ws://localhost:3000/desktop/ws?mode=control");
});

test("the viewer tags its session with the active run for replay", () => {
  assert.equal(
    desktopWsUrl("view", LOC, "client-1", "run_abc"),
    "wss://swarmagents.codes/desktop/ws?mode=view&client=client-1&run=run_abc",
  );
  assert.equal(
    desktopWsUrl("control", LOC, undefined, "../../etc/passwd"),
    "wss://swarmagents.codes/desktop/ws?mode=control",
    "invalid run ids are never sent to the proxy",
  );
});

test("the viewer can ask for a named agent's desktop", () => {
  assert.equal(
    desktopWsUrl("view", LOC, "client-1", "run_abc", "worker-2"),
    "wss://swarmagents.codes/desktop/ws?mode=view&client=client-1&run=run_abc&agent=worker-2",
  );
  // The default agent (A1) sends no agent param: its desktop is the per-user VM.
  assert.equal(
    desktopWsUrl("view", LOC, undefined, undefined, "a1"),
    "wss://swarmagents.codes/desktop/ws?mode=view",
  );
  assert.equal(
    desktopWsUrl("view", LOC, undefined, undefined, "../escape"),
    "wss://swarmagents.codes/desktop/ws?mode=view",
    "invalid agent ids are never sent to the proxy",
  );
});

test("the proxy path constants match the d2 contract", () => {
  assert.equal(DESKTOP_WS_PATH, "/desktop/ws");
  assert.equal(DESKTOP_SCREENSHOT_PATH, "/api/runtime/vm/screenshot");
  assert.equal(DESKTOP_FRAME_WIDTH / DESKTOP_FRAME_HEIGHT, 16 / 9);
});
