// Paste plumbing for the computer-mcp `type` tool (core-27).
//
// The paste path is: put the text on the X CLIPBOARD selection (reusing the
// clipboard plumbing from core-10, clipboard.mjs), send the paste chord —
// Ctrl+V, or Ctrl+Shift+V when the focused window is a terminal that binds
// Ctrl+V to its own line-editing buffer — then restore the previous clipboard
// contents, best effort. All commands are argv arrays (never shell strings).
// Nothing here rejects: every step returns a result object.

import { spawn as nodeSpawn } from "node:child_process";
import { readClipboard, writeClipboard } from "./clipboard.mjs";

/**
 * X window classes whose paste chord is Ctrl+Shift+V instead of Ctrl+V.
 * xterm, xfce4-terminal and gnome-terminal all bind Ctrl+V to their own
 * line-editing buffer, so a plain Ctrl+V would not reach the application.
 */
export const TERMINAL_CLASSES = Object.freeze([
  "xterm",
  "xfce4-terminal",
  "gnome-terminal",
  "gnome-terminal-server",
]);

/** True when a focused-window class string names a paste-with-Shift terminal. */
export function isTerminalClass(name) {
  const raw = String(name ?? "").trim().toLowerCase();
  return raw !== "" && TERMINAL_CLASSES.some((cls) => raw.includes(cls));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn one argv command; resolves `{ code, stdout, stderr }`; never rejects.
 * Used for the xdotool chord (and the active-window probe); clipboard reads
 * and writes go through clipboard.mjs instead.
 */
export function runCmd(spawnImpl, program, args, { env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(program, args, {
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ code: 124, stdout, stderr: `${stderr}timed out`.trim() });
    }, timeoutMs);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => settle({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => settle({ code: code ?? 0, stdout, stderr }));
  });
}

/**
 * The focused window's WM_CLASS (e.g. "xfce4-terminal.Xfce4-terminal"), or ""
 * when it cannot be determined. EWMH-aware: the active window id comes from
 * xdotool, the class from `wmctrl -lx` (the same tool describe_screen uses).
 */
export async function activeWindowClass({ spawnImpl = nodeSpawn, env, timeoutMs = 5_000 } = {}) {
  const act = await runCmd(spawnImpl, "xdotool", ["getactivewindow"], { env, timeoutMs });
  if (act.code !== 0) return "";
  // xdotool prints decimal ids, wmctrl prints hex (0x...) — compare numerically.
  const winId = Number(act.stdout.trim().split(/\s+/)[0]);
  if (!Number.isFinite(winId) || winId <= 0) return "";
  const list = await runCmd(spawnImpl, "wmctrl", ["-lx"], { env, timeoutMs });
  if (list.code !== 0) return "";
  for (const line of String(list.stdout).split(/\r?\n/)) {
    const m = /^(\S+)\s+\S+\s+(\S+)\s+/.exec(line);
    if (m && Number(m[1]) === winId) return m[2];
  }
  return "";
}

/**
 * Paste `text` into the focused window. Returns
 * `{ ok: true, mode: "paste", chars, ms, combo }` or `{ ok: false, error }`.
 * Restoring the previous clipboard is best effort and never fails the call.
 */
export async function pasteText(text, { spawnImpl = nodeSpawn, env, settleMs = 50, restoreMs = 150, timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  const prev = await readClipboard({ spawnImpl, env, timeoutMs });
  const written = await writeClipboard({ spawnImpl, text: String(text), env, timeoutMs });
  if (!written.ok) return { ok: false, error: `could not set clipboard: ${written.error}` };
  // Give the new selection owner a moment before the paste chord goes down.
  await sleep(settleMs);
  const klass = await activeWindowClass({ spawnImpl, env });
  const combo = isTerminalClass(klass) ? "ctrl+shift+v" : "ctrl+v";
  const keyRes = await runCmd(spawnImpl, "xdotool", ["key", combo], { env, timeoutMs });
  if (keyRes.code !== 0) {
    return {
      ok: false,
      error: `sending ${combo} failed: ${(keyRes.stderr || keyRes.stdout || `exit code ${keyRes.code}`).trim()}`,
    };
  }
  // Let the focused app read the selection before it is restored.
  await sleep(restoreMs);
  if (prev.ok) {
    await writeClipboard({ spawnImpl, text: prev.text, env, timeoutMs });
  }
  return { ok: true, mode: "paste", chars: String(text).length, ms: Date.now() - started, combo };
}
