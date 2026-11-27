import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  EFFECT_HINT,
  HintCounter,
  captureFingerprint,
  effectPoint,
  fingerprintsDiffer,
  formatEffectLine,
  noteEffectResult,
  regionGeometry,
  resetEffectCounter,
  setCaptureRunnerForTesting,
  settle,
} from "../../vm-image-desktop/computer-mcp/effect.mjs";

test.afterEach(() => {
  setCaptureRunnerForTesting(null);
  resetEffectCounter();
});

const fp = (hash: string, windowId = "1", windowTitle = "Editor") => ({ hash, windowId, windowTitle });

test("fingerprintsDiffer: pixels, focused window and title each count; missing data never claims a change", () => {
  assert.equal(fingerprintsDiffer(fp("a"), fp("a")), false);
  assert.equal(fingerprintsDiffer(fp("a"), fp("b")), true);
  assert.equal(fingerprintsDiffer(fp("a"), fp("a", "2")), true);
  assert.equal(fingerprintsDiffer(fp("a"), fp("a", "1", "Save As")), true);
  assert.equal(fingerprintsDiffer(null, fp("a")), false);
  assert.equal(fingerprintsDiffer(fp("a"), null), false);
});

test("settle: returns as soon as the screen changes", async () => {
  const seq = [fp("a"), fp("a"), fp("b")];
  let calls = 0;
  const res = await settle(fp("a"), () => { calls += 1; return seq.shift() ?? fp("b"); }, { timeoutMs: 1000, intervalMs: 5, initialMs: 0 });
  assert.equal(res.changed, true);
  assert.equal(calls, 3);
  assert.ok(res.elapsedMs < 500);
});

test("settle: reports no change after the timeout", async () => {
  const res = await settle(fp("a"), () => fp("a"), { timeoutMs: 40, intervalMs: 10, initialMs: 0 });
  assert.equal(res.changed, false);
  assert.ok(res.elapsedMs >= 30);
});

test("hint after three consecutive no-change actions; a change resets the streak", () => {
  const c = new HintCounter();
  assert.equal(c.record(false), null);
  assert.equal(c.record(false), null);
  assert.equal(c.record(false), EFFECT_HINT);
  assert.equal(c.record(false), null, "streak resets after hinting");
  c.record(false);
  c.record(true);
  assert.equal(c.record(false), null);
  assert.equal(noteEffectResult(false), null);
  assert.equal(noteEffectResult(false), null);
  assert.match(noteEffectResult(false) ?? "", /describe_screen or inspect_ui/);
});

test("effect line names focus changes and real elapsed time", () => {
  const changed = formatEffectLine({ changed: true, before: fp("a"), after: fp("b", "9", "Save As"), elapsedMs: 300 }, { x: 10, y: 20 });
  assert.equal(changed, 'effect: screen changed near (10, 20); focus moved to "Save As"');
  const none = formatEffectLine({ changed: false, before: fp("a"), after: fp("a"), elapsedMs: 1500 }, null);
  assert.equal(none, "effect: NO visible change after 1.5s; focused window unchanged");
});

test("region fingerprint only for point actions, clamped to the screen origin", () => {
  assert.deepEqual(effectPoint({ x: 5, y: 7 }, "click"), { x: 5, y: 7 });
  assert.equal(effectPoint({ text: "hi" }, "type"), null);
  assert.equal(regionGeometry({ x: 50, y: 50 }), "400x300+0+0");
  assert.equal(regionGeometry({ x: 1000, y: 800 }), "400x300+800+650");
  assert.equal(regionGeometry(null), null);
});

test("captureFingerprint uses the injected runner and survives runner errors", async () => {
  setCaptureRunnerForTesting(() => fp("x"));
  assert.deepEqual(await captureFingerprint(), fp("x"));
  setCaptureRunnerForTesting(() => { throw new Error("boom"); });
  assert.equal(await captureFingerprint(), null);
});

// Real X server: proves the fingerprint is stable on a static screen (PNG
// timestamps must not leak into the hash) and detects a real keystroke.
const haveX = ["Xvfb", "scrot", "convert", "xdotool", "xterm"].every((b) => spawnSync("which", [b]).status === 0);

test("real Xvfb: static screen is stable, typing into xterm is a change, clicking empty root is not", { skip: !haveX && "needs Xvfb, scrot, imagemagick, xdotool, xterm", timeout: 30_000 }, async () => {
  // A free display from a wide range: parallel test files and live evals also
  // start Xvfb servers, and a collision would silently point us at theirs.
  let n = 0;
  for (let i = 0; i < 50 && (!n || existsSync(`/tmp/.X${n}-lock`)); i++) n = 300 + Math.floor(Math.random() * 600);
  const display = `:${n}`;
  const prevDisplay = process.env.DISPLAY;
  const procs: ChildProcess[] = [];
  try {
    procs.push(spawn("Xvfb", [display, "-screen", "0", "800x600x24", "-nolisten", "tcp"], { stdio: "ignore" }));
    process.env.DISPLAY = display;
    for (let i = 0; i < 50 && spawnSync("xdotool", ["getmouselocation"], { timeout: 2_000 }).status !== 0; i++) await new Promise((r) => setTimeout(r, 100));
    procs.push(spawn("xterm", ["-geometry", "60x15+0+0"], { stdio: "ignore", env: { ...process.env } }));
    for (let i = 0; i < 50 && spawnSync("xdotool", ["search", "--class", "xterm"], { timeout: 2_000 }).status !== 0; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 800));
    spawnSync("xdotool", ["search", "--class", "xterm", "windowfocus"]);
    await new Promise((r) => setTimeout(r, 300));

    const a = await captureFingerprint();
    const b = await captureFingerprint();
    assert.ok(a && a.hash, "captured a pixel hash");
    assert.equal(fingerprintsDiffer(a, b), false, "two captures of an unchanged screen must match");

    const opts = { timeoutMs: 1500, intervalMs: 100, initialMs: 50 };
    // Empty root area far from the xterm: a click there changes nothing.
    const point = { x: 700, y: 520 };
    const beforeRoot = await captureFingerprint({ point });
    spawnSync("xdotool", ["mousemove", "700", "520", "click", "1"]);
    const rootRes = await settle(beforeRoot, () => captureFingerprint({ point }), opts);
    assert.equal(rootRes.changed, false, formatEffectLine(rootRes, point));

    spawnSync("xdotool", ["search", "--class", "xterm", "windowfocus"]);
    const beforeType = await captureFingerprint();
    spawnSync("xdotool", ["type", "--delay", "20", "hello effect"]);
    const typeRes = await settle(beforeType, () => captureFingerprint(), opts);
    assert.equal(typeRes.changed, true, "typed text must show up as a change");
  } finally {
    for (const p of procs.reverse()) p.kill("SIGKILL");
    if (prevDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = prevDisplay;
  }
});
