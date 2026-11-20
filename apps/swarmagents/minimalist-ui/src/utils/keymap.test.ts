import { test } from "node:test";
import assert from "node:assert/strict";
import { mapKeyToAction } from "./keymap";

function ev(partial: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }>) {
  return { key: "", metaKey: false, ctrlKey: false, altKey: false, ...partial };
}

test("Cmd/Ctrl+K maps to focusing the input", () => {
  assert.deepEqual(mapKeyToAction(ev({ key: "k", metaKey: true }), false), { type: "focusInput" });
  assert.deepEqual(mapKeyToAction(ev({ key: "K", ctrlKey: true }), true), { type: "focusInput" });
});

test("Cmd/Ctrl+1..4 maps to the three screen views plus telemetry drawer", () => {
  assert.deepEqual(mapKeyToAction(ev({ key: "1", metaKey: true }), false), { type: "view", view: "terminal" });
  assert.deepEqual(mapKeyToAction(ev({ key: "2", ctrlKey: true }), true), { type: "view", view: "browser" });
  assert.deepEqual(mapKeyToAction(ev({ key: "3", metaKey: true }), false), { type: "view", view: "files" });
  assert.deepEqual(mapKeyToAction(ev({ key: "4", ctrlKey: true }), false), { type: "telemetry" });
});

test("? opens help and Escape closes, only when not typing", () => {
  assert.deepEqual(mapKeyToAction(ev({ key: "?" }), false), { type: "help" });
  assert.equal(mapKeyToAction(ev({ key: "?" }), true), null);
  assert.deepEqual(mapKeyToAction(ev({ key: "Escape" }), false), { type: "close" });
});

test("Escape while typing stops the active run", () => {
  assert.deepEqual(mapKeyToAction(ev({ key: "Escape" }), true), { type: "stopRun" });
  // Other bare keys never hijack typing.
  assert.equal(mapKeyToAction(ev({ key: "a" }), true), null);
  assert.equal(mapKeyToAction(ev({ key: "?" }), true), null);
});

test("unmapped keys and chords return null", () => {
  assert.equal(mapKeyToAction(ev({ key: "a" }), false), null);
  assert.equal(mapKeyToAction(ev({ key: "k" }), false), null);
  assert.equal(mapKeyToAction(ev({ key: "a", metaKey: true }), false), null);
  assert.equal(mapKeyToAction(ev({ key: "k", metaKey: true, altKey: true }), false), null);
  assert.equal(mapKeyToAction(ev({ key: "1" }), false), null);
});
