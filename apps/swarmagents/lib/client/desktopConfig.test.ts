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

test("the proxy path constants match the d2 contract", () => {
  assert.equal(DESKTOP_WS_PATH, "/desktop/ws");
  assert.equal(DESKTOP_SCREENSHOT_PATH, "/api/runtime/vm/screenshot");
  assert.equal(DESKTOP_FRAME_WIDTH / DESKTOP_FRAME_HEIGHT, 16 / 9);
});
