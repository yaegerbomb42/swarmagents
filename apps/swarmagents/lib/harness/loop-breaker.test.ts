import test from "node:test";
import assert from "node:assert/strict";
import {
  LoopBreaker,
  actionFingerprint,
  consumeLoopNudge,
  isLoopExempt,
  outputHash,
} from "./loop-breaker";

const click = { toolName: "mcp__computer__click", input: { x: 412, y: 300 }, output: "click done" };

test("same click, same coordinates, same output x3 -> nudge", () => {
  const lb = new LoopBreaker();
  assert.equal(lb.observe(click).kind, "none");
  assert.equal(lb.observe(click).kind, "none");
  const v = lb.observe(click);
  assert.equal(v.kind, "nudge");
  assert.ok(v.kind === "nudge" && /Do NOT repeat that same call/.test(v.message));
  assert.ok(v.kind === "nudge" && v.fingerprint === actionFingerprint(click.toolName, click.input));
});

test("scroll / key / wait / screenshot x3 never fire", () => {
  for (const [toolName, input] of [
    ["mcp__computer__scroll", { dy: 3 }],
    ["mcp__computer__key", { keys: "Tab" }],
    ["mcp__computer__wait", { ms: 1000 }],
    ["mcp__computer__screenshot", {}],
    ["mcp__playwright__browser_wait_for", { time: 2 }],
    ["mcp__playwright__browser_press_key", { key: "ArrowDown" }],
  ] as const) {
    const lb = new LoopBreaker();
    for (let i = 0; i < 6; i++) {
      assert.equal(lb.observe({ toolName, input, output: "done" }).kind, "none", toolName);
    }
  }
});

test("Bash polls (sleep, curl health) are exempt; a repeated real command is not", () => {
  assert.equal(isLoopExempt("Bash", { command: "sleep 5" }), true);
  assert.equal(isLoopExempt("Bash", { command: "sleep 2 && curl -s localhost:3000/health" }), true);
  assert.equal(isLoopExempt("Bash", { command: "curl -s localhost:3000/health" }), true);
  assert.equal(isLoopExempt("Bash", { command: "npm test" }), false);
  assert.equal(isLoopExempt("Bash", { command: "rm -rf build && sleep 1" }), false);
});

test("exempt observations in between do not break the streak", () => {
  const lb = new LoopBreaker();
  const shot = { toolName: "mcp__computer__screenshot", input: {}, output: "[image]" };
  lb.observe(click);
  lb.observe(shot);
  lb.observe(click);
  lb.observe(shot);
  assert.equal(lb.observe(click).kind, "nudge");
});

test("different output or different input resets the streak", () => {
  const lb = new LoopBreaker();
  lb.observe(click);
  lb.observe(click);
  assert.equal(lb.observe({ ...click, output: "click done\neffect: screen changed" }).kind, "none");
  assert.equal(lb.observe({ ...click, input: { x: 413, y: 300 } }).kind, "none");
});

test("volatile timestamps / durations do not make outputs look different", () => {
  assert.equal(outputHash("clicked at 12:00:01 in 35ms"), outputHash("clicked at 12:00:09 in 41ms"));
  assert.notEqual(outputHash("clicked OK"), outputHash("clicked Cancel"));
});

test("still repeating after the nudge -> escalate", () => {
  const lb = new LoopBreaker();
  for (let i = 0; i < 2; i++) lb.observe(click);
  assert.equal(lb.observe(click).kind, "nudge");
  // The hook denied the 4th try (that result is an error, so it breaks the streak).
  assert.equal(lb.observe({ ...click, output: "Loop breaker: ... not executed" }).kind, "none");
  lb.observe(click);
  lb.observe(click);
  assert.equal(lb.observe(click).kind, "escalate");
});

test("input key order does not change the fingerprint", () => {
  assert.equal(actionFingerprint("t", { a: 1, b: { c: 2, d: 3 } }), actionFingerprint("t", { b: { d: 3, c: 2 }, a: 1 }));
});

test("consumeLoopNudge denies only the exact looping call", () => {
  const pending = { fingerprint: actionFingerprint(click.toolName, click.input), message: "nudge!" };
  assert.equal(consumeLoopNudge(pending, click.toolName, { y: 300, x: 412 }), "nudge!");
  assert.equal(consumeLoopNudge(pending, click.toolName, { x: 10, y: 10 }), null);
  assert.equal(consumeLoopNudge(undefined, click.toolName, click.input), null);
});
