// Action-effect feedback for the SwarmAgents computer-use MCP server (core-23).
//
// After an input action we take a cheap screen fingerprint, wait briefly for
// the screen to settle, and tell the model whether anything visibly changed.
// The fingerprint hashes RAW downscaled grayscale pixels (ImageMagick
// `gray:-` output), never PNG file bytes: scrot/PNG files embed creation-time
// chunks, so hashing the file reports "changed" on every call.
//
// Capture is injectable (setCaptureRunnerForTesting) so the settle / hint
// logic is unit-testable without an X server.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const HINT_AFTER = 3;
const FINGERPRINT_SIZE = "64x64!";

export const EFFECT_HINT =
  "hint: your last few actions changed nothing on screen. Call describe_screen or inspect_ui, check the focused window, or use focus_window / click_text.";

/** SWARM_EFFECT_FEEDBACK=0 turns the feature off. */
export function effectEnabled() {
  return process.env.SWARM_EFFECT_FEEDBACK !== "0";
}

function run(program, args, { timeoutMs = 10_000, encoding = "utf8" } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { env: process.env, shell: false });
    } catch (err) {
      resolve({ code: -1, stdout: encoding ? "" : Buffer.alloc(0), stderr: String(err) });
      return;
    }
    const out = [];
    let stderr = "";
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      resolve({ code, stdout: encoding ? buf.toString(encoding) : buf, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish(124);
    }, timeoutMs);
    child.stdout?.on("data", (c) => out.push(c));
    child.stderr?.on("data", (c) => { stderr += c; });
    child.on("error", (err) => { stderr += String(err); finish(-1); });
    child.on("close", (code) => finish(code ?? 0));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

let captureRunner = null;

/** Replace the real X capture with a fake (tests). Pass null to restore. */
export function setCaptureRunnerForTesting(runner) {
  captureRunner = typeof runner === "function" ? runner : null;
}

/**
 * Fingerprint = { hash, windowId, windowTitle }. `opts.point` + `opts.regionSize`
 * restrict the pixel hash to a region around the action point.
 * Returns null when nothing could be captured (feedback is then skipped).
 */
export async function captureFingerprint(opts = {}) {
  if (captureRunner) {
    try {
      return normalize(await captureRunner(opts));
    } catch {
      return null;
    }
  }
  return defaultCapture(opts);
}

/** ImageMagick crop geometry for a region centred on `point`, clamped at 0. */
export function regionGeometry(point, size = { w: 400, h: 300 }) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const x = Math.max(0, Math.round(point.x - size.w / 2));
  const y = Math.max(0, Math.round(point.y - size.h / 2));
  return `${size.w}x${size.h}+${x}+${y}`;
}

async function defaultCapture(opts) {
  const file = path.join(os.tmpdir(), `swarm-effect-${process.pid}-${crypto.randomUUID()}.png`);
  try {
    const shot = await run("scrot", ["-o", file]);
    let hash = "";
    if (shot.code === 0) {
      const geom = regionGeometry(opts.point, opts.regionSize);
      const args = [file];
      if (geom) args.push("-crop", geom, "+repage");
      // 4-bit gray quantisation absorbs anti-aliasing / compression noise.
      args.push("-resize", FINGERPRINT_SIZE, "-colorspace", "Gray", "-depth", "4", "gray:-");
      const px = await run("convert", args, { encoding: null });
      if (px.code === 0 && px.stdout.length > 0) {
        hash = crypto.createHash("sha1").update(px.stdout).digest("hex");
      }
    }
    const win = await captureWindow();
    if (!hash && !win.id) return null;
    return { hash, windowId: win.id, windowTitle: win.title };
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

async function captureWindow() {
  const id = await run("xdotool", ["getactivewindow"], { timeoutMs: 3_000 });
  const name = await run("xdotool", ["getactivewindow", "getwindowname"], { timeoutMs: 3_000 });
  return {
    id: id.code === 0 ? id.stdout.trim() : "",
    title: name.code === 0 ? name.stdout.trim() : "",
  };
}

function normalize(fp) {
  if (!fp || typeof fp !== "object") return null;
  return {
    hash: String(fp.hash ?? ""),
    windowId: String(fp.windowId ?? ""),
    windowTitle: String(fp.windowTitle ?? ""),
  };
}

/** True when pixels, the focused window or its title differ. */
export function fingerprintsDiffer(before, after) {
  const a = normalize(before);
  const b = normalize(after);
  if (!a || !b) return false; // no comparable data: never claim a change
  return a.hash !== b.hash || a.windowId !== b.windowId || a.windowTitle !== b.windowTitle;
}

/**
 * Poll `capture` until it differs from `before` or `timeoutMs` passes.
 * Returns { changed, before, after, elapsedMs }.
 */
export async function settle(before, capture, { timeoutMs = 1500, intervalMs = 200, initialMs = 100 } = {}) {
  const start = Date.now();
  await sleep(initialMs);
  let after = normalize(await capture());
  while (!fingerprintsDiffer(before, after) && Date.now() - start + intervalMs <= timeoutMs) {
    await sleep(intervalMs);
    after = normalize(await capture());
  }
  return { changed: fingerprintsDiffer(before, after), before: normalize(before), after, elapsedMs: Date.now() - start };
}

/** Emits EFFECT_HINT after `threshold` consecutive no-change actions. */
export class HintCounter {
  constructor(threshold = HINT_AFTER) {
    this.threshold = threshold;
    this.streak = 0;
  }
  record(changed) {
    if (changed) {
      this.streak = 0;
      return null;
    }
    this.streak += 1;
    if (this.streak < this.threshold) return null;
    this.streak = 0;
    return EFFECT_HINT;
  }
}

let sessionCounter = new HintCounter();

/** Record one action's outcome for this server process; returns a hint or null. */
export function noteEffectResult(changed) {
  return sessionCounter.record(Boolean(changed));
}

export function resetEffectCounter() {
  sessionCounter = new HintCounter();
}

/** The screen point an action targets, used to fingerprint just that region. */
export function effectPoint(args, tool) {
  const a = args && typeof args === "object" ? args : {};
  if ((tool === "click" || tool === "double_click") && Number.isFinite(a.x) && Number.isFinite(a.y)) {
    return { x: a.x, y: a.y };
  }
  return null; // drag/type/key/scroll/open_app: whole screen
}

/** One line appended to the tool result. */
export function formatEffectLine(res, point) {
  const where = point ? ` near (${point.x}, ${point.y})` : "";
  const secs = (Math.max(0, res?.elapsedMs ?? 0) / 1000).toFixed(1);
  if (!res?.changed) return `effect: NO visible change${where} after ${secs}s; focused window unchanged`;
  const parts = [`effect: screen changed${where}`];
  const b = res.before;
  const a = res.after;
  if (a && b && a.windowId !== b.windowId) parts.push(`focus moved to "${a.windowTitle || a.windowId}"`);
  else if (a && b && a.windowTitle !== b.windowTitle) parts.push(`window title now "${a.windowTitle}"`);
  return parts.join("; ");
}
