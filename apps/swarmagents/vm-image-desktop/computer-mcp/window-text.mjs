/**
 * In-window text capture for the computer-use MCP server (window-text.mjs).
 *
 * `read_window_text` (and describe_screen's "Active window text" section)
 * crop the active — or a title-matched — window using its wmctrl frame
 * geometry, then OCR the crop with tesseract `--psm 6` (uniform block: reads
 * consecutive text lines in order, unlike the sparse `--psm 11` used for
 * click targets). Returns the visible text as ordered lines (last `maxLines`
 * — terminal/app output sits at the bottom), plus the window title and
 * geometry.
 *
 * The wmctrl frame includes window decorations: the content area sits a few
 * pixels above and inside the frame (e.g. ~29 px under xfwm4's title bar).
 * Cropping the raw frame would clip the first text row, so the crop is
 * expanded slightly into the title bar (and inward on the sides) and clamped
 * to the screen geometry.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseWmctrlWindows, parseTesseractText, selectLastLines } from "./validate.mjs";

/** Default max lines returned by read_window_text (last lines = newest). */
export const DEFAULT_WINDOW_TEXT_LINES = 60;
/** Hard cap for maxLines (validated in validate.mjs, clamped here too). */
export const MAX_WINDOW_TEXT_LINES = 200;
/** The OCR mode: uniform block — ordered text lines, not sparse word targets. */
export const WINDOW_TEXT_PSM = "6";
/** How far the crop extends into the title bar (frame decorations) — px. */
const CROP_TOP_EXPAND = 40;
/** Side padding inside the frame, so border pixels do not clip text — px. */
const CROP_SIDE_INSET = 8;

/**
 * Pick the window to read: the focused window by default (with the active
 * window id, or the first listed window as a fallback on decoration-less
 * sessions); otherwise the first window whose title contains `title`
 * (case-insensitive). Returns the parsed record or null.
 */
export function pickWindow(windows, activeId, title) {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  if (title) {
    const needle = String(title).trim().toLowerCase();
    return windows.find((w) => w.title.toLowerCase().includes(needle)) ?? null;
  }
  const activeNum = activeId ? Number(activeId) : NaN;
  const active = Number.isFinite(activeNum)
    ? windows.find((w) => parseInt(w.id, 16) === activeNum)
    : undefined;
  return active ?? windows[0];
}

/**
 * Crop rectangle for `window` with `screenW` x `screenH` geometry. The frame
 * (wmctrl) is expanded 40 px upward into the decoration and 8 px outward on
 * each side — top and left text can sit right at the inner frame edge — then
 * clamped to the screen. Returns {x, y, w, h} for ImageMagick
 * `convert -crop WxH+X+Y +repage`.
 */
export function windowCrop(window, screenW, screenH) {
  const x = Math.max(0, window.x - CROP_SIDE_INSET);
  const y = Math.max(0, window.y - CROP_TOP_EXPAND);
  const x2 = Math.min(screenW, window.x + window.w + CROP_SIDE_INSET);
  const y2 = Math.min(screenH, window.y + window.h);
  return {
    x,
    y,
    w: Math.max(1, x2 - x),
    h: Math.max(1, y2 - y),
  };
}

/** Mean luminance below this (0..1) = a dark window (terminal) to invert. */
export const DARK_MEAN_THRESHOLD = 0.5;

/**
 * ImageMagick args that prepare a window crop for tesseract: grayscale,
 * `-negate` when the crop is dark (light text on dark), 2x upscale,
 * normalize. `meanStdout` is `convert -format %[fx:mean]` output; unparsable
 * means "not dark".
 */
export function ocrPrepArgs(meanStdout) {
  const mean = Number.parseFloat(String(meanStdout ?? "").trim());
  const dark = Number.isFinite(mean) && mean < DARK_MEAN_THRESHOLD;
  return ["-colorspace", "Gray", ...(dark ? ["-negate"] : []), "-resize", "200%", "-normalize"];
}

/**
 * Capture the text of a window (active, or title-matched when `title` is
 * given) via wmctrl geometry + scrot + ImageMagick crop + tesseract --psm 6.
 *
 * `run` is the injected spawn runner (server.mjs's `run`) so tests can pass a
 * stub; it resolves `{ code, stdout, stderr }`. Never throws: returns
 * `{ ok: true, title, geometry, lines, truncated }` or
 * `{ ok: false, error }` with a clear message (missing tools, no window).
 */
export async function captureWindowText({ run, title, maxLines = DEFAULT_WINDOW_TEXT_LINES, env }) {
  const cap = Math.min(Math.max(Number(maxLines) || DEFAULT_WINDOW_TEXT_LINES, 1), MAX_WINDOW_TEXT_LINES);

  const geomRes = await run("xdotool", ["getdisplaygeometry"], { timeoutMs: 5_000, env });
  if (geomRes.code !== 0) {
    return { ok: false, error: `display geometry unavailable: ${(geomRes.stderr || geomRes.stdout).trim() || `exit code ${geomRes.code}`}` };
  }
  const geomMatch = /^(\d+)\s+(\d+)/.exec(geomRes.stdout.trim());
  if (!geomMatch) return { ok: false, error: "display geometry unavailable" };
  const screenW = Number(geomMatch[1]);
  const screenH = Number(geomMatch[2]);

  const winRes = await run("wmctrl", ["-lG"], { timeoutMs: 5_000, env });
  if (winRes.code !== 0) {
    return { ok: false, error: `window list unavailable: ${(winRes.stderr || winRes.stdout).trim() || `exit code ${winRes.code}`}` };
  }
  const windows = parseWmctrlWindows(winRes.stdout);
  const activeRes = await run("xdotool", ["getactivewindow"], { timeoutMs: 5_000, env });
  const activeId = activeRes.code === 0 ? activeRes.stdout.trim() : "";
  const window = pickWindow(windows, activeId, title);
  if (!window) {
    return { ok: false, error: title ? `no window with title "${title}" found.` : "no window found." };
  }

  const crop = windowCrop(window, screenW, screenH);
  const file = path.join(os.tmpdir(), `swarm-window-text-${process.pid}-${Date.now()}.png`);
  try {
    const shot = await run("scrot", ["-o", file], { timeoutMs: 12_000, env });
    if (shot.code !== 0) {
      return { ok: false, error: `screenshot failed (is scrot installed?): ${(shot.stderr || shot.stdout).trim() || `exit code ${shot.code}`}` };
    }
    const cut = await run("convert", [file, "-crop", `${crop.w}x${crop.h}+${crop.x}+${crop.y}`, "+repage", file], { timeoutMs: 12_000, env });
    if (cut.code !== 0) {
      return { ok: false, error: `crop failed (is ImageMagick installed?): ${(cut.stderr || cut.stdout).trim() || `exit code ${cut.code}`}` };
    }
    // Dark-terminal fix (core-38): tesseract reads light-on-dark terminal
    // text as garbage. Grayscale, invert dark crops to dark-on-light, then
    // upscale 2x so small monospace glyphs clear tesseract's x-height floor.
    const meanRes = await run("convert", [file, "-colorspace", "Gray", "-format", "%[fx:mean]", "info:"], { timeoutMs: 12_000, env });
    const prep = ocrPrepArgs(meanRes.code === 0 ? meanRes.stdout : "");
    const pre = await run("convert", [file, ...prep, file], { timeoutMs: 12_000, env });
    if (pre.code !== 0) {
      return { ok: false, error: `OCR preprocessing failed: ${(pre.stderr || pre.stdout).trim().slice(0, 120) || `exit code ${pre.code}`}` };
    }
    const ocr = await run("tesseract", [file, "stdout", "--psm", WINDOW_TEXT_PSM], { timeoutMs: 15_000, env });
    if (ocr.code !== 0) {
      return { ok: false, error: `OCR failed (is tesseract installed?): ${(ocr.stderr || ocr.stdout).trim().slice(0, 120) || `exit code ${ocr.code}`}` };
    }
    const allLines = parseTesseractText(ocr.stdout);
    const lines = selectLastLines(allLines, cap);
    return {
      ok: true,
      title: window.title,
      geometry: `${window.x},${window.y} ${window.w}x${window.h}`,
      lines,
      truncated: allLines.length > lines.length,
    };
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

/**
 * The short "Active window text (OCR, last 15 lines):" section for
 * describe_screen, computed with the same capture helper (shared code path
 * with read_window_text). Returns the section text, or null when the capture
 * cannot run (no window / missing tools) — describe_screen then simply omits
 * the section.
 */
export async function activeWindowTextSection({ run, env }) {
  const res = await captureWindowText({ run, maxLines: 15, env });
  if (!res.ok) return null;
  const lines = res.lines.join("\n");
  return `Active window text (OCR, last 15 lines): ${res.title} @ (${res.geometry})\n${lines}`;
}
