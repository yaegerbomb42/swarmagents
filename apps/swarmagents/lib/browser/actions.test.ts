/**
 * Unit tests for lib/browser/actions.ts (interactive browser actions +
 * bounded page evaluation). A fake Page stands in for Playwright, so no
 * Chromium is needed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { evaluatePageExpression, executeBrowserAction, type BrowserAction } from "./actions";

interface LocatorCalls {
  selector: string;
  method: string;
  args: unknown[];
}

function fakeActionPage(overrides: { evaluateImpl?: (fn: (expr: string) => unknown, arg: string) => unknown } = {}): {
  page: Page;
  calls: LocatorCalls[];
} {
  const calls: LocatorCalls[] = [];
  const locator = (selector: string) => {
    const record = (method: string, args: unknown[] = []) => {
      calls.push({ selector, method, args });
    };
    return {
      first: () => ({
        click: async (opts?: unknown) => record("click", [opts]),
        fill: async (text: string) => record("fill", [text]),
        type: async (text: string) => record("type", [text]),
        press: async (key: string) => record("press", [key]),
        hover: async () => record("hover"),
        waitFor: async (opts?: unknown) => record("waitFor", [opts]),
      }),
    };
  };
  const page = {
    locator,
    keyboard: { press: async (key: string) => calls.push({ selector: "", method: "keyboard.press", args: [key] }) },
    mouse: { wheel: async (dx: number, dy: number) => calls.push({ selector: "", method: "mouse.wheel", args: [dx, dy] }) },
    evaluate: async (fn: (expr: string) => unknown, arg: string) =>
      overrides.evaluateImpl ? overrides.evaluateImpl(fn, arg) : fn(arg),
  } as unknown as Page;
  return { page, calls };
}

test("click validates the selector and clamps clickCount to 1..3", async () => {
  const { page, calls } = fakeActionPage();
  await executeBrowserAction(page, { kind: "click", selector: "  #btn ", button: "right", clickCount: 9 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selector, "#btn");
  assert.equal(calls[0].method, "click");
  const opts = calls[0].args[0] as { button: string; clickCount: number };
  assert.equal(opts.button, "right");
  assert.equal(opts.clickCount, 3);

  await assert.rejects(executeBrowserAction(page, { kind: "click", selector: "   " }), /Invalid selector/);
  await assert.rejects(executeBrowserAction(page, { kind: "click", selector: "x".repeat(513) }), /Invalid selector/);
});

test("type enforces the text limit and uses fill/press for clear/submit", async () => {
  const { page, calls } = fakeActionPage();
  await executeBrowserAction(page, { kind: "type", selector: "input", text: "hello", clear: true, submit: true });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["fill", "press"],
  );
  assert.deepEqual(calls[1].args, ["Enter"]);

  await assert.rejects(
    executeBrowserAction(page, { kind: "type", selector: "input", text: "x".repeat(16_385) }),
    /Text must be <= 16384/,
  );
});

test("press validates the key and prefers the locator when a selector is given", async () => {
  const { page, calls } = fakeActionPage();
  await executeBrowserAction(page, { kind: "press", key: "Enter", selector: "input" });
  assert.equal(calls[0].method, "press");

  await executeBrowserAction(page, { kind: "press", key: "Tab" });
  assert.equal(calls[1].method, "keyboard.press");

  await assert.rejects(executeBrowserAction(page, { kind: "press", key: "  " }), /Invalid key/);
  await assert.rejects(executeBrowserAction(page, { kind: "press", key: "x".repeat(65) }), /Invalid key/);
});

test("scroll defaults to a 600px vertical wheel and hovers a selector first", async () => {
  const { page, calls } = fakeActionPage();
  await executeBrowserAction(page, { kind: "scroll" });
  assert.deepEqual(calls[0].args, [0, 600]);

  await executeBrowserAction(page, { kind: "scroll", deltaX: -10, deltaY: 0, selector: ".pane" });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["mouse.wheel", "hover", "mouse.wheel"],
  );
  assert.deepEqual(calls[2].args, [-10, 0]);
});

test("wait defaults to the visible state", async () => {
  const { page, calls } = fakeActionPage();
  await executeBrowserAction(page, { kind: "wait", selector: "#app" });
  const opts = calls[0].args[0] as { state: string };
  assert.equal(opts.state, "visible");
});

test("evaluate returns JSON-serializable values and rejects bad input", async () => {
  const { page } = fakeActionPage();
  assert.equal(await evaluatePageExpression(page, "1 + 2"), 3);
  assert.deepEqual(await evaluatePageExpression(page, "({ a: 1, b: [2, 3] })"), { a: 1, b: [2, 3] });
  assert.equal(await evaluatePageExpression(page, "undefined"), null);

  await assert.rejects(evaluatePageExpression(page, "   "), /1\.\.8192/);
  await assert.rejects(evaluatePageExpression(page, "x".repeat(8193)), /1\.\.8192/);
});

test("evaluate refuses non-serializable results", async () => {
  const { page } = fakeActionPage();
  await assert.rejects(
    evaluatePageExpression(page, "(()=>{ const o = {}; o.self = o; return o; })()"),
    /circular/,
  );
});

test("evaluate enforces the race timeout", async () => {
  const { page } = fakeActionPage({
    evaluateImpl: () => new Promise(() => {}),
  });
  await assert.rejects(evaluatePageExpression(page, "1", 50), /timed out/);
});

test("executeBrowserAction accepts every BrowserAction kind", async () => {
  const { page } = fakeActionPage();
  const actions: BrowserAction[] = [
    { kind: "click", selector: "button" },
    { kind: "type", selector: "input", text: "hi" },
    { kind: "press", key: "Escape" },
    { kind: "scroll", deltaY: 100 },
    { kind: "wait", selector: "main" },
  ];
  for (const action of actions) {
    await executeBrowserAction(page, action);
  }
});
