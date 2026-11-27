#!/usr/bin/env node
// SwarmAgents computer-use MCP stdio server (desktop mode).
//
// Gives the Claude Code agent inside the desktop VM real control of the
// on-screen desktop (display :1 by default): screenshots, mouse input,
// typing, hotkeys, scrolling and opening apps. Everything is implemented
// with xdotool/scrot/ImageMagick via argv arrays — never shell strings — so
// no argument can be interpreted as a command. All argument validation and
// argv construction lives in ./validate.mjs (shared with the harness's risk
// and telemetry layer).
//
// Transport: stdio only (no network listener). Run by the role MCP wiring
// as `node /opt/swarm/computer-mcp/server.mjs`.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import {
  clearsTerminalLine,
  normalizeToolArgs,
  parseToolArgs,
  summarizeTool,
  COMPUTER_TOOLS,
  OPEN_APP_NAMES,
  parseWmctrlWindows,
  parseTesseractTsv,
  parseAtspiDump,
  filterUiNodes,
  formatUiNodes,
  findTextTarget,
  TYPE_PASTE_MARKER,
} from "./validate.mjs";
import { capClipboardText, writeClipboard } from "./clipboard.mjs";
import { activeWindowClass, isTerminalClass, pasteText } from "./paste.mjs";
import { captureWindowText, activeWindowTextSection } from "./window-text.mjs";
import {
  effectEnabled,
  captureFingerprint,
  settle,
  effectPoint,
  formatEffectLine,
  noteEffectResult,
} from "./effect.mjs";

const DISPLAY = process.env.SWARM_COMPUTER_DISPLAY || process.env.DISPLAY || ":1";
// Text-desktop mode (non-vision model): `screenshot` answers with the
// describe_screen text instead of PNG bytes. The harness sets this via the
// --mcp-config env (SWARM_TEXT_DESKTOP=1); it is the fail-closed layer
// under the approval-hook deny, covering runs without the hook.
const TEXT_DESKTOP = process.env.SWARM_TEXT_DESKTOP === "1";
// Constrain the tools' own child processes, never the server itself.
const CHILD_ENV = { ...process.env, DISPLAY };
const SCREENSHOT_DIR = os.tmpdir();
const MAX_SHOT_SIZE = 4 * 1024 * 1024;
const SCREENSHOT_MAX_WIDTH = 1280;
/** AT-SPI2 tree dump helper shipped next to this server (python3-pyatspi). */
const ATSPI_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "atspi_dump.py");
/** How many AT-SPI2 widgets describe_screen lists (inspect_ui can return more). */
const DESCRIBE_UI_ITEMS = 60;

function fail(message) {
  return { content: [{ type: "text", text: String(message) }], isError: true };
}

function textResult(text) {
  return { content: [{ type: "text", text: String(text) }], isError: false };
}

/** Spawn a program with an argv array; resolves {code, stdout, stderr}. */
function run(program, args, { timeoutMs = 30_000, env = CHILD_ENV } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { env, shell: false });
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
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ code: 124, stdout, stderr: `${stderr}timed out`.trim() });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/** Run a list of argv commands in sequence; first failure stops the chain. */
async function runAll(cmds, label) {
  for (const argv of cmds) {
    const res = await run("xdotool", argv);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      return fail(`${label} failed: ${detail || `exit code ${res.code}`}`);
    }
  }
  return textResult(`${label} done`);
}

/**
 * Said after every type that did not end in Return: the live desktop eval
 * (core-36/37) showed cheap models typing a terminal command and declaring
 * it done without ever running it.
 */
const NO_ENTER_NOTE = " (Enter NOT pressed: if this is a command or form, call key Return or type with submit:true)";

/**
 * The `type` tool: keys mode runs xdotool argv (the classic per-line typing);
 * paste mode puts the text on the clipboard, sends the paste chord (Ctrl+V,
 * or Ctrl+Shift+V when the focused window is a terminal), and restores the
 * previous clipboard best effort. Result line states the mode and count.
 */
/**
 * Unsubmitted terminal input (core-37). Cheap models type `ls`, then `pwd`,
 * then a real command into a terminal without ever pressing Enter, so the
 * prompt fills with `lspwdecho ...` and nothing runs. When text is typed into
 * a terminal without Return we remember it; the next type into the SAME
 * terminal is refused once with a clear instruction. Nothing is ever run
 * implicitly: the model still decides to press Return (or clear the line).
 */
let pendingTerminalLine = null; // { win: number, text: string }

/** The focused window id and whether it is a terminal; never throws. */
async function focusedTerminal() {
  const act = await run("xdotool", ["getactivewindow"], { timeoutMs: 3_000 });
  const win = act.code === 0 ? Number(act.stdout.trim().split(/\s+/)[0]) : NaN;
  if (!Number.isFinite(win) || win <= 0) return { win: 0, terminal: false };
  const klass = await activeWindowClass({ env: CHILD_ENV, timeoutMs: 3_000 });
  return { win, terminal: isTerminalClass(klass) };
}

/** Called after a successful `key` call. */
function noteKeyCombo(combo) {
  if (clearsTerminalLine(combo)) pendingTerminalLine = null;
}

async function typeTool(args, cmds) {
  const submits = typeof args.text === "string" && args.text.endsWith("\n");
  const focus = await focusedTerminal();
  if (focus.terminal && pendingTerminalLine && pendingTerminalLine.win === focus.win) {
    const pending = pendingTerminalLine.text.slice(-80);
    pendingTerminalLine = null; // refuse once, never deadlock
    return fail(
      `type refused: "${pending}" is still sitting on this terminal's prompt and never ran (Enter was not pressed). ` +
        `Call key Return to run it, or key ctrl+u to clear it, then type again. Tip: type {text, submit:true} types and runs in one call.`,
    );
  }
  const result = await typeInto(args, cmds);
  if (!result.isError && focus.terminal) {
    pendingTerminalLine = submits ? null : { win: focus.win, text: String(args.text ?? "") };
  }
  return result;
}

async function typeInto(args, cmds) {
  const [marker, payload] = cmds[0];
  if (marker === TYPE_PASTE_MARKER) {
    const res = await pasteText(payload, { env: CHILD_ENV });
    if (!res.ok) return fail(`paste failed: ${res.error}`);
    // Trailing newlines ride as Return presses after the paste.
    const rest = cmds.slice(1);
    if (rest.length > 0) {
      const keys = await runAll(rest, "type");
      if (keys.isError) return keys;
    }
    const enter = rest.length > 0 ? ` + Return${rest.length > 1 ? ` x${rest.length}` : ""}` : NO_ENTER_NOTE;
    return textResult(`Pasted ${res.chars} chars via clipboard (${res.combo})${enter} in ${res.ms}ms`);
  }
  const n = typeof args.text === "string" ? args.text.length : 0;
  const res = await runAll(cmds, "type");
  if (res.isError) return res;
  const submitted = typeof args.text === "string" && args.text.endsWith("\n");
  return textResult(`Typed ${n} chars via keys${submitted ? " + Return" : NO_ENTER_NOTE}`);
}

/** Measure the image width in pixels via `identify` ("" when unavailable). */
async function imageWidth(file) {
  const res = await run("identify", ["-format", "%w", file], { timeoutMs: 10_000 });
  if (res.code !== 0) return 0;
  const width = Number(res.stdout.trim());
  return Number.isFinite(width) && width > 0 ? width : 0;
}

/** Capture the whole display as PNG, downscaled to <=1280 px wide. */
async function captureScreenshot() {
  const file = path.join(SCREENSHOT_DIR, `swarm-shot-${process.pid}-${Date.now()}.png`);
  const shot = await run("scrot", ["-o", file], { timeoutMs: 15_000 });
  if (shot.code !== 0) {
    return fail(`screenshot failed: ${(shot.stderr || shot.stdout).trim() || `exit code ${shot.code}`}`);
  }
  try {
    const width = await imageWidth(file);
    if (width > SCREENSHOT_MAX_WIDTH) {
      const scaled = await run("convert", [file, "-resize", `${SCREENSHOT_MAX_WIDTH}x>`, file], {
        timeoutMs: 15_000,
      });
      if (scaled.code !== 0) {
        return fail(`screenshot downscale failed: ${(scaled.stderr || scaled.stdout).trim()}`);
      }
    }
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_SHOT_SIZE) return fail("screenshot too large");
    const data = (await fs.promises.readFile(file)).toString("base64");
    return {
      content: [
        { type: "text", text: `Screenshot captured (${stat.size} bytes).` },
        { type: "image", data, mimeType: "image/png" },
      ],
      isError: false,
    };
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

/** Capture OCR targets on display :1 using scrot + tesseract TSV. */
async function captureOcrTargets(maxItems = 150) {
  const file = path.join(SCREENSHOT_DIR, `swarm-ocr-${process.pid}-${Date.now()}.png`);
  const shot = await run("scrot", ["-o", file], { timeoutMs: 12_000 });
  try {
    if (shot.code !== 0) {
      return { ok: false, error: (shot.stderr || shot.stdout || "scrot failed").trim(), targets: [] };
    }
    const ocr = await run("tesseract", [file, "stdout", "--psm", "11", "tsv"], { timeoutMs: 15_000 });
    if (ocr.code !== 0) {
      return { ok: false, error: (ocr.stderr || "tesseract unavailable").trim().slice(0, 120), targets: [] };
    }
    return { ok: true, targets: parseTesseractTsv(ocr.stdout, maxItems) };
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

/** Capture a SHA-256 hash of the current display :1 screenshot. */
async function captureScreenHash() {
  const file = path.join(SCREENSHOT_DIR, `swarm-hash-${process.pid}-${Date.now()}.png`);
  const shot = await run("scrot", ["-o", file], { timeoutMs: 12_000 });
  try {
    if (shot.code !== 0) return null;
    const buf = await fs.promises.readFile(file);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

/**
 * Walk the AT-SPI2 accessibility tree via the python helper. `helperArgs` is
 * the validated argv tail from parseToolArgs("inspect_ui"). Resolves the
 * parsed dump; never throws (an unavailable tree is `{ ok: false }`).
 */
async function readAccessibilityTree(helperArgs, maxItems) {
  const res = await run("python3", [ATSPI_HELPER, ...helperArgs], { timeoutMs: 10_000 });
  if (res.code !== 0 && !res.stdout.trim()) {
    return { ok: false, error: (res.stderr || `exit code ${res.code}`).trim().slice(0, 160), apps: [], truncated: false, nodes: [] };
  }
  return parseAtspiDump(res.stdout, maxItems);
}

/** inspect_ui: semantic widgets (role, name, states, click center) from AT-SPI2. */
async function inspectUi(args, helperArgs) {
  const maxItems = Number(args?.maxItems) || 120;
  const dump = await readAccessibilityTree(helperArgs, 400);
  if (!dump.ok) {
    return textResult(
      `Accessibility tree unavailable (${dump.error}). Fall back to describe_screen (OCR text targets) or screenshot.`,
    );
  }
  const nodes = filterUiNodes(dump.nodes, { query: args?.query, role: args?.role, maxItems });
  const header = `UI elements (${nodes.length}${dump.truncated ? ", tree truncated" : ""}) from apps: ${dump.apps.join(", ") || "none"}`;
  if (nodes.length === 0) {
    return textResult(`${header}\nNo matching elements. Try without query/role, or use describe_screen for OCR text.`);
  }
  return textResult(`${header}\n${formatUiNodes(nodes)}`);
}

/**
 * Structured non-vision desktop inspection: screen dimensions, pointer location,
 * open windows with clickable center coordinates, and optional OCR text lines
 * with bounding boxes + center (x, y) coordinates for click/double_click.
 */
async function describeScreen(args) {
  const includeOcr = args?.includeOcr !== false;
  const includeUi = args?.includeUi !== false;
  const maxItems = Math.min(Math.max(Number(args?.maxItems) || 80, 1), 150);

  const [geomRes, mouseRes, winRes, activeRes, uiDump] = await Promise.all([
    run("xdotool", ["getdisplaygeometry"], { timeoutMs: 5_000 }),
    run("xdotool", ["getmouselocation"], { timeoutMs: 5_000 }),
    run("wmctrl", ["-lG"], { timeoutMs: 5_000 }),
    run("xdotool", ["getactivewindow", "getwindowname"], { timeoutMs: 5_000 }),
    includeUi ? readAccessibilityTree(["--max", String(DESCRIBE_UI_ITEMS)], DESCRIBE_UI_ITEMS) : Promise.resolve(null),
  ]);

  const geom = geomRes.code === 0 ? geomRes.stdout.trim().replace(/\s+/g, "x") : "unknown";
  const pointer = mouseRes.code === 0 ? mouseRes.stdout.trim() : "unknown";
  const activeWin = activeRes.code === 0 ? activeRes.stdout.trim() : "none";
  const windows = winRes.code === 0 ? parseWmctrlWindows(winRes.stdout) : [];

  const lines = [
    `Screen: ${geom} | Active window: ${activeWin || "none"} | Pointer: ${pointer}`,
    windows.length > 0
      ? "Windows:\n" + windows.map((w) => `  [${w.id}] "${w.title}" @ (${w.x},${w.y} ${w.w}x${w.h}) center=(${w.cx},${w.cy})`).join("\n")
      : "Windows: none",
  ];

  if (uiDump) {
    lines.push(
      uiDump.ok
        ? uiDump.nodes.length > 0
          ? `UI elements (AT-SPI2, ${uiDump.nodes.length}${uiDump.truncated ? ", more via inspect_ui" : ""}):\n${formatUiNodes(uiDump.nodes)}`
          : "UI elements (AT-SPI2): none exposed"
        : `UI elements (AT-SPI2) unavailable: ${uiDump.error}`,
    );
  }

  if (includeOcr) {
    const ocrRes = await captureOcrTargets(maxItems);
    if (ocrRes.ok) {
      lines.push(
        ocrRes.targets.length > 0
          ? `Clickable text targets (${ocrRes.targets.length}):\n` +
              ocrRes.targets.map((t) => `  "${t.text}" -> click(${t.cx}, ${t.cy}) [${t.x},${t.y} ${t.w}x${t.h}]`).join("\n")
          : "Clickable text targets: none detected",
      );
    } else {
      lines.push(`OCR skipped (${ocrRes.error})`);
    }

    // Ordered text of the focused window, produced by the same pipeline as
    // read_window_text — a text-only model can read cat/compiler output
    // without the word-level click targets. Terminals only: for GUI apps
    // (spreadsheets, editors) a full-window OCR dump is slow noise next to
    // the click targets above; read_window_text stays available for them.
    const klass = await activeWindowClass({ env: CHILD_ENV, timeoutMs: 3_000 });
    if (isTerminalClass(klass)) {
      const winText = await activeWindowTextSection({ run, env: CHILD_ENV });
      if (winText) lines.push(winText);
    }
  }

  return textResult(lines.join("\n"));
}

async function clickText(args) {
  const ocrRes = await captureOcrTargets(150);
  if (!ocrRes.ok) return fail(`click_text OCR failed: ${ocrRes.error}`);
  const hit = findTextTarget(ocrRes.targets, args.text, { exact: args.exact === true });
  if (!hit) return fail(`click_text: "${String(args.text).trim()}" not found on screen.`);
  const clickTool = args.double === true ? "double_click" : "click";
  const parsedClick = parseToolArgs(clickTool, { x: hit.cx, y: hit.cy, button: args.button });
  if (!parsedClick.ok) return fail(parsedClick.error);
  const res = await runAll(parsedClick.cmds, clickTool.replace("_", " "));
  if (res.isError) return res;
  return textResult(`Clicked "${hit.text}" at (${hit.cx}, ${hit.cy})`);
}

async function waitForText(args) {
  const timeoutMs = Number(args.timeoutMs ?? 10_000);
  const pollMs = Number(args.pollMs ?? 500);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const ocrRes = await captureOcrTargets(150);
    if (ocrRes.ok) {
      const hit = findTextTarget(ocrRes.targets, args.text);
      if (hit) return textResult(`Found "${hit.text}" at (${hit.cx}, ${hit.cy})`);
    }
    if (Date.now() + pollMs > deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return fail(`wait_for_text timed out after ${timeoutMs}ms waiting for "${String(args.text).trim()}"`);
}

async function waitForScreenChange(args) {
  const timeoutMs = Number(args.timeoutMs ?? 10_000);
  const pollMs = Number(args.pollMs ?? 500);
  const baseline = await captureScreenHash();
  if (!baseline) return fail("wait_for_screen_change failed to capture baseline screenshot.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (Date.now() + pollMs > deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
    const current = await captureScreenHash();
    if (current && current !== baseline) {
      return textResult("Screen changed.");
    }
  }
  return fail(`wait_for_screen_change timed out after ${timeoutMs}ms`);
}

async function clipboardGet(args) {
  const selection = args.selection === "primary" ? "primary" : "clipboard";
  const res = await run("xclip", ["-o", "-selection", selection], { timeoutMs: 5_000 });
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    if (/target STRING not available/i.test(detail)) return textResult("");
    return fail(`clipboard_get failed: ${detail || `exit code ${res.code}`}`);
  }
  const capped = capClipboardText(res.stdout);
  return textResult(
    capped.truncated
      ? `${capped.text}\n[clipboard truncated: showing ${capped.text.length} of ${capped.total} chars]`
      : capped.text,
  );
}

async function clipboardSet(args) {
  const selection = args.selection === "primary" ? "primary" : "clipboard";
  const res = await writeClipboard({ spawnImpl: spawn, text: String(args.text), selection, env: CHILD_ENV });
  if (!res.ok) return fail(`clipboard_set failed: ${res.error}`);
  return textResult(`Clipboard (${selection}) updated (${args.text.length} chars).`);
}

async function focusWindow(args, cmdArgs) {
  const res = await run("wmctrl", cmdArgs, { timeoutMs: 5_000 });
  if (res.code === 0) return textResult(`Focused window matching "${args.title.trim()}"`);
  const fallback = await run("xdotool", ["search", "--name", args.title.trim(), "windowactivate"], { timeoutMs: 5_000 });
  if (fallback.code === 0) return textResult(`Focused window matching "${args.title.trim()}"`);
  return fail(`focus_window failed: ${(res.stderr || fallback.stderr || "window not found").trim()}`);
}

/**
 * Tools whose purpose is to change what is on screen. `move` is deliberately
 * not here: scrot does not capture the cursor, so a pointer move would always
 * report "NO visible change" and push the agent toward the hint.
 */
const EFFECT_TOOLS = new Set([
  "click",
  "double_click",
  "drag",
  "type",
  "key",
  "scroll",
  "open_app",
]);

/** settle window per input tool: app launch is slower than a click/type. */
function effectSettleOpts(tool) {
  return tool === "open_app"
    ? { timeoutMs: 3000, intervalMs: 200, initialMs: 100 }
    : { timeoutMs: 1500, intervalMs: 200, initialMs: 100 };
}

/**
 * Run an input action with action-effect feedback: capture a fingerprint
 * before, run the action, then settle on the screen and append an effect line
 * (and, after repeated no-changes, a hint) to the tool result.
 */
async function withEffect(tool, args, action) {
  if (!EFFECT_TOOLS.has(tool) || !effectEnabled()) return action();
  // Fingerprint the region around the action point when there is one — a
  // full-screen scrot per poll is costly — else the whole screen.
  const point = effectPoint(args, tool);
  const captureOpts = point ? { point, regionSize: { w: 400, h: 300 } } : {};
  const before = await captureFingerprint(captureOpts);
  if (before === null) return action();
  const result = await action();
  if (result?.isError) return result;
  const settleRes = await settle(before, () => captureFingerprint(captureOpts), effectSettleOpts(tool));
  const hint = noteEffectResult(settleRes.changed);
  const line = formatEffectLine(settleRes, point);
  if (result?.content?.[0]?.text) {
    result.content[0].text = `${result.content[0].text}\n${line}${hint ? `\n${hint}` : ""}`;
  }
  return result;
}

async function callTool(tool, rawArgs) {
  // Common argument slips (key {"key":"Enter"}, focus_window {"window_name"},
  // open_app {"app_name"}, type {submit:true}) are mapped to the canonical
  // names first, so every handler below sees one spelling (core-37).
  const args = normalizeToolArgs(tool, rawArgs);
  // All input tools go through the shared validator, producing argv arrays.
  const parsed = parseToolArgs(tool, args);
  if (!parsed.ok) return fail(parsed.error);

  switch (tool) {
    case "screenshot":
      // Text-desktop runs never produce image bytes: describe_screen text
      // is the only screen reading a model without vision can use.
      return TEXT_DESKTOP ? describeScreen(args) : captureScreenshot();
    case "describe_screen":
      return describeScreen(args);
    case "read_window_text": {
      const res = await captureWindowText({ run, title: args?.title, maxLines: args?.maxLines, env: CHILD_ENV });
      if (!res.ok) return fail(`read_window_text failed: ${res.error}`);
      const lines = res.lines;
      const tail = res.truncated
        ? `\n[showing last ${lines.length} lines; ${res.title} has more]`
        : "";
      return textResult(
        `Window "${res.title}" @ (${res.geometry}) text:\n${lines.length > 0 ? lines.join("\n") : "(no text detected)"}${tail}`,
      );
    }
    case "inspect_ui":
      return inspectUi(args, parsed.cmds[0]);
    case "click_text":
      return clickText(args);
    case "wait_for_text":
      return waitForText(args);
    case "wait_for_screen_change":
      return waitForScreenChange(args);
    case "clipboard_get":
      return clipboardGet(args);
    case "clipboard_set":
      return clipboardSet(args);
    case "focus_window":
      return focusWindow(args, parsed.cmds[0]);
    case "wait": {
      const ms = Number(args?.ms ?? 0);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return textResult(`Waited ${ms}ms`);
    }
    case "type":
      return withEffect("type", args, () => typeTool(args, parsed.cmds));
    case "open_app": {
      const [program] = parsed.cmds[0];
      return withEffect("open_app", args, () => {
        let child;
        try {
          child = spawn(program, parsed.cmds[0].slice(1), { env: CHILD_ENV, detached: true, stdio: "ignore" });
        } catch (err) {
          return fail(`open_app failed: ${String(err)}`);
        }
        child.on("error", () => { /* the app may fail to launch; the user sees it */ });
        child.unref();
        return textResult(`Opening ${args.name}`);
      });
    }
    case "key":
      return withEffect("key", args, async () => {
        const res = await runAll(parsed.cmds, "key");
        if (!res.isError) noteKeyCombo(args.combo);
        return res;
      });
    default:
      return withEffect(tool, args, () => runAll(parsed.cmds, tool.replace("_", " ")));
  }
}

const server = new McpServer({ name: "swarm-computer", version: "1.0.0" });

// Tool input schemas as zod raw shapes (the SDK requires zod schemas for
// `inputSchema`). The shapes are deliberately loose — they describe the
// accepted JSON types to MCP clients — while every actual call is validated
// in `callTool` by the shared `parseToolArgs` validator, the single source
// of truth for ranges, charsets and argv construction.
const XY_SHAPE = {
  x: z.union([z.number(), z.string()]).optional().describe("X coordinate on the desktop (0..4096)."),
  y: z.union([z.number(), z.string()]).optional().describe("Y coordinate on the desktop (0..4096)."),
  coordinate: z.array(z.union([z.number(), z.string()])).optional().describe("Alternative to x/y: [x, y]."),
  button: z.union([z.number(), z.string()]).optional().describe("Mouse button: 1 left, 2 middle, 3 right, 4..7 wheel."),
};
const DRAG_SHAPE = {
  x1: z.union([z.number(), z.string()]).describe("Start X (0..4096)."),
  y1: z.union([z.number(), z.string()]).describe("Start Y (0..4096)."),
  x2: z.union([z.number(), z.string()]).describe("End X (0..4096)."),
  y2: z.union([z.number(), z.string()]).describe("End Y (0..4096)."),
};
const COMBO = z.union([z.number(), z.string()]);
const AXIS_SHAPE = { dx: COMBO.describe("Horizontal wheel steps (≤200)."), dy: COMBO.describe("Vertical wheel steps (≤200).") };

/** The zod raw shape + description for a tool. */
function toolSpec(tool) {
  switch (tool) {
    case "screenshot":
      return {
        description: TEXT_DESKTOP
          ? "Describe the desktop as text (windows + OCR coordinates) — screenshots are disabled in text-desktop mode."
          : "Capture the desktop as a PNG, downscaled to at most 1280px wide (display :1).",
        shape: {},
      };
    case "describe_screen":
      return {
        description: "Inspect display :1 without vision: returns screen geometry, window bounds/centers, AT-SPI2 UI elements (role, name, state, click center), OCR clickable text coordinates (x, y), and the ordered text of the active window (last 15 lines).",
        shape: {
          includeOcr: z.boolean().optional().describe("Include OCR word/line coordinates and active-window text (default true)."),
          includeUi: z.boolean().optional().describe("Include AT-SPI2 accessibility widgets (default true)."),
          maxItems: z.number().optional().describe("Max OCR targets to return (1..150, default 80)."),
        },
      };
    case "read_window_text":
      return {
        description:
          'Read the ordered text displayed in a window: crops the active window (or the first window whose title contains `title`) via its wmctrl geometry, OCRs it with tesseract --psm 6 (uniform block), and returns the last maxLines lines (terminal output appears at the bottom), plus the window title and geometry. Use it to read command output, errors, or codes a non-vision model cannot see in a screenshot.',
        shape: {
          title: z.string().optional().describe("Window title substring to match (1..120 chars); defaults to the active window."),
          maxLines: z.union([z.number(), z.string()]).optional().describe("Max lines to return (1..200, default 60)."),
        },
      };
    case "inspect_ui":
      return {
        description:
          "List semantic UI widgets from the AT-SPI2 accessibility tree (buttons, menus, tabs, inputs, check boxes, scrollbars...) with role, name, states (focused/disabled/checked/selected/expanded) and the click(x, y) center. Works for GTK, Qt and Chromium/Electron apps; catches icon buttons and menus OCR misses.",
        shape: {
          app: z.string().optional().describe("Only this application (name substring, e.g. \"chromium\", \"thunar\")."),
          query: z.string().optional().describe("Only widgets whose name contains this text (case-insensitive)."),
          role: z.string().optional().describe("Only widgets whose role contains this, e.g. \"button\", \"menu item\", \"entry\"."),
          maxItems: z.number().optional().describe("Max widgets to return (1..300, default 120)."),
        },
      };
    case "click":
      return { description: "Move the pointer to (x, y) and click the given button.", shape: XY_SHAPE };
    case "double_click":
      return { description: "Move the pointer to (x, y) and double-click.", shape: XY_SHAPE };
    case "click_text":
      return {
        description: "Find visible text on display :1 via OCR and click its center.",
        shape: {
          text: z.string().describe("Visible text label to click (1..120 chars)."),
          button: z.union([z.number(), z.string()]).optional().describe("Mouse button 1..7 (default 1)."),
          double: z.boolean().optional().describe("Double-click instead of single click."),
          exact: z.boolean().optional().describe("Require exact text match instead of substring."),
        },
      };
    case "move":
      return { description: "Move the pointer to (x, y) without pressing any button.", shape: XY_SHAPE };
    case "drag":
      return { description: "Drag from (x1, y1) to (x2, y2) with the left button pressed.", shape: DRAG_SHAPE };
    case "type":
      return {
        description:
          'Type text into the focused window. It does NOT press Enter: set submit:true (or end text with a newline) to run a command. Mode "auto" pastes via clipboard for long/multiline/non-ASCII text, fast and exact; mode "keys" types per-line keyboard input).',
        shape: {
          text: z.string().optional().describe('Text to type (max 2000 chars in "keys" mode, 20000 in "paste" mode). A trailing newline presses Return.'),
          submit: z.boolean().optional().describe("Press Return after typing (e.g. to run a terminal command). Without it, type never presses Enter."),
          content: z.string().optional().describe("Alias of text."),
          value: z.string().optional(),
          enter: z.boolean().optional(),
          press_enter: z.boolean().optional(),
          mode: z.enum(["auto", "keys", "paste"]).optional().describe('"auto" (default) pastes when the text is >200 chars, multiline or non-ASCII; "keys" always types via keyboard; "paste" always uses the clipboard.'),
        },
      };
    case "key":
      return {
        description: "Press a key or key combo, e.g. \"Return\", \"ctrl+l\", \"alt+Tab\".",
        shape: {
          combo: z.string().optional().describe('Keysym combo (max 64 chars), e.g. "Return", "ctrl+c". "Enter"/"Esc" are accepted.'),
          key: z.string().optional().describe("Alias of combo."),
          keys: z.union([z.string(), z.array(z.string())]).optional().describe('Alias of combo; ["ctrl","l"] means "ctrl+l".'),
          keysym: z.string().optional(),
        },
      };
    case "scroll":
      return { description: "Scroll by wheel steps: positive dy scrolls down, negative up; dx scrolls right/left.", shape: AXIS_SHAPE };
    case "open_app":
      return {
        description:
          "Open a desktop application: browser (Chromium), terminal, files (Thunar), libreoffice (Writer), spreadsheet (LibreOffice Calc), gimp (image editing) or blender (3D).",
        shape: {
          name: z.string().optional().describe(`One of: ${OPEN_APP_NAMES.join(", ")}.`),
          app: z.string().optional().describe("Alias of name."),
          app_name: z.string().optional().describe("Alias of name."),
          appName: z.string().optional(),
          application: z.string().optional(),
        },
      };
    case "focus_window":
      return {
        description: "Bring a desktop window whose title matches `title` to the foreground.",
        shape: {
          title: z.string().optional().describe("Window title substring (1..120 chars)."),
          window_title: z.string().optional().describe("Alias of title."),
          window_name: z.string().optional().describe("Alias of title."),
          // Undocumented spellings still seen live; declared so the MCP
          // schema layer does not strip them before normalizeToolArgs.
          window: z.string().optional(),
          windowTitle: z.string().optional(),
          name: z.string().optional(),
        },
      };
    case "wait":
      return {
        description: "Wait for a number of milliseconds (max 300000).",
        shape: { ms: z.union([z.number(), z.string()]).describe("Milliseconds to wait.") },
      };
    case "wait_for_text":
      return {
        description: "Poll display :1 via OCR until `text` appears or timeout expires.",
        shape: {
          text: z.string().describe("Text to wait for (1..120 chars)."),
          timeoutMs: z.union([z.number(), z.string()]).optional().describe("Timeout in ms (100..60000, default 10000)."),
          pollMs: z.union([z.number(), z.string()]).optional().describe("Poll interval in ms (200..5000, default 500)."),
        },
      };
    case "wait_for_screen_change":
      return {
        description: "Poll display :1 until the screen pixels change or timeout expires.",
        shape: {
          timeoutMs: z.union([z.number(), z.string()]).optional().describe("Timeout in ms (100..60000, default 10000)."),
          pollMs: z.union([z.number(), z.string()]).optional().describe("Poll interval in ms (200..5000, default 500)."),
        },
      };
    case "clipboard_get":
      return {
        description: "Read text from the X11 clipboard or primary selection.",
        shape: { selection: z.enum(["clipboard", "primary"]).optional() },
      };
    case "clipboard_set":
      return {
        description: "Write text into the X11 clipboard or primary selection.",
        shape: {
          text: z.string().describe("Text to copy to clipboard (max 20000 chars)."),
          selection: z.enum(["clipboard", "primary"]).optional(),
        },
      };
    default:
      return { description: tool, shape: {} };
  }
}

for (const tool of COMPUTER_TOOLS) {
  const { description, shape } = toolSpec(tool);
  server.registerTool(tool, { title: tool, description, inputSchema: shape }, async (args) => callTool(tool, args));
}

const transport = new StdioServerTransport();
await server.connect(transport);
