import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleTabIndex, getFocusableElements, isTextEntry } from "./focusTrap";

/** Minimal stand-in for an HTMLElement for getFocusableElements. */
function fakeEl(props: { disabled?: boolean; tabIndex?: number } = {}) {
  return {
    tabIndex: props.tabIndex ?? 0,
    hasAttribute: (name: string) => (name === "disabled" ? !!props.disabled : false),
    focus: () => undefined,
  };
}

test("cycleTabIndex wraps Tab forward and Shift+Tab backward", () => {
  assert.equal(cycleTabIndex(3, 0, false), 1);
  assert.equal(cycleTabIndex(3, 2, false), 0); // wraps at the end
  assert.equal(cycleTabIndex(3, 0, true), 2); // wraps at the start
  assert.equal(cycleTabIndex(3, 1, true), 0);
  // Focus outside the dialog: Tab enters at the first element.
  assert.equal(cycleTabIndex(3, -1, false), 0);
  assert.equal(cycleTabIndex(3, -1, true), 2);
  assert.equal(cycleTabIndex(0, -1, false), -1);
  assert.equal(cycleTabIndex(1, 0, false), 0);
});

test("getFocusableElements keeps enabled elements and drops disabled ones", () => {
  const enabled = fakeEl();
  const disabled = fakeEl({ disabled: true });
  const negativeTab = fakeEl({ tabIndex: -1 });
  const container = {
    querySelectorAll: () => [enabled, disabled, negativeTab],
  } as unknown as HTMLElement;
  assert.deepEqual(getFocusableElements(container), [enabled]);
});

test("isTextEntry is true only for elements the user types text into", () => {
  // A dialog that opens by itself leaves the cursor in these (see deferToTyping).
  assert.equal(isTextEntry({ tagName: "TEXTAREA" }), true);
  assert.equal(isTextEntry({ tagName: "INPUT" }), true, "an input with no type is a text field");
  assert.equal(isTextEntry({ tagName: "INPUT", type: "search" }), true);
  assert.equal(isTextEntry({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTextEntry({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTextEntry({ tagName: "INPUT", type: "range" }), false);
  assert.equal(isTextEntry({ tagName: "BUTTON" }), false);
  assert.equal(isTextEntry({ tagName: "BODY" }), false);
  assert.equal(isTextEntry(null), false);
});
