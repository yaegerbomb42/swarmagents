import test from "node:test";
import assert from "node:assert/strict";
import {
  DISPLAY_CLOSE_NOT_FOUND,
  DISPLAY_CLOSE_SESSION_EXPIRED,
  DISPLAY_CLOSE_UNAVAILABLE,
  describeDisplayClose,
  refusalCloseCode,
  resolveDisplayAvailability,
  useVmDisplay,
} from "./useVmDisplay";

test("describeDisplayClose: maps the proxy's refusal codes to friendly messages", () => {
  assert.equal(
    describeDisplayClose(DISPLAY_CLOSE_SESSION_EXPIRED),
    "Your session expired. Sign in again to view your computer.",
  );
  assert.equal(
    describeDisplayClose(DISPLAY_CLOSE_NOT_FOUND),
    "Desktop not found. The VM may have been reset — reconnect to start a fresh one.",
  );
  assert.equal(describeDisplayClose(DISPLAY_CLOSE_UNAVAILABLE), "Desktop not available on this server.");
  // Ordinary drops (clean close, abnormal close) have no error copy —
  // they are the reconnecting path, not a message.
  assert.equal(describeDisplayClose(1000), undefined);
  assert.equal(describeDisplayClose(1006), undefined);
  assert.equal(describeDisplayClose(1011), undefined);
});

test("refusalCloseCode: an errored VM reads as unavailable, anything else as not found", () => {
  assert.equal(refusalCloseCode("error"), DISPLAY_CLOSE_UNAVAILABLE);
  assert.equal(refusalCloseCode("ready"), DISPLAY_CLOSE_NOT_FOUND);
  assert.equal(refusalCloseCode("starting"), DISPLAY_CLOSE_NOT_FOUND);
  assert.equal(refusalCloseCode("hibernated"), DISPLAY_CLOSE_NOT_FOUND);
});

test("resolveDisplayAvailability: booting counts as available, hibernated/error do not", () => {
  assert.deepEqual(resolveDisplayAvailability("ready"), { available: true });
  assert.deepEqual(resolveDisplayAvailability("starting"), { available: true });
  assert.deepEqual(resolveDisplayAvailability("hibernated"), {
    available: false,
    unavailableMessage: "Your computer is hibernated. Wake it to watch the desktop.",
  });
  assert.deepEqual(resolveDisplayAvailability("error"), {
    available: false,
    unavailableMessage: "Desktop not available on this server",
  });
});

test("useVmDisplay: exposes availability plus the close-code map", () => {
  assert.equal(useVmDisplay("ready").available, true);
  assert.equal(useVmDisplay("error").unavailableMessage, "Desktop not available on this server");
  assert.equal(useVmDisplay("ready").describeClose(4404), describeDisplayClose(4404));
});
