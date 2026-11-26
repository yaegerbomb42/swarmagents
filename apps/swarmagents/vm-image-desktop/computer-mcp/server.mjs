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
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseToolArgs, summarizeTool, COMPUTER_TOOLS, OPEN_APP_NAMES, parseWmctrlWindows, parseTesseractTsv } from "./validate.mjs";

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

/**
 * Structured non-vision desktop inspection: screen dimensions, pointer location,
 * open windows with clickable center coordinates, and optional OCR text lines
 * with bounding boxes + center (x, y) coordinates for click/double_click.
 */
async function describeScreen(args) {
  const includeOcr = args?.includeOcr !== false;
  const maxItems = Math.min(Math.max(Number(args?.maxItems) || 80, 1), 150);

  const [geomRes, mouseRes, winRes, activeRes] = await Promise.all([
    run("xdotool", ["getdisplaygeometry"], { timeoutMs: 5_000 }),
    run("xdotool", ["getmouselocation"], { timeoutMs: 5_000 }),
    run("wmctrl", ["-lG"], { timeoutMs: 5_000 }),
    run("xdotool", ["getactivewindow", "getwindowname"], { timeoutMs: 5_000 }),
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

  if (includeOcr) {
    const file = path.join(SCREENSHOT_DIR, `swarm-ocr-${process.pid}-${Date.now()}.png`);
    const shot = await run("scrot", ["-o", file], { timeoutMs: 12_000 });
    try {
      if (shot.code === 0) {
        const ocr = await run("tesseract", [file, "stdout", "--psm", "11", "tsv"], { timeoutMs: 15_000 });
        if (ocr.code === 0) {
          const targets = parseTesseractTsv(ocr.stdout, maxItems);
          lines.push(
            targets.length > 0
              ? `Clickable text targets (${targets.length}):\n` +
                  targets.map((t) => `  "${t.text}" -> click(${t.cx}, ${t.cy}) [${t.x},${t.y} ${t.w}x${t.h}]`).join("\n")
              : "Clickable text targets: none detected",
          );
        } else {
          lines.push(`OCR skipped (${(ocr.stderr || "tesseract unavailable").trim().slice(0, 120)})`);
        }
      }
    } finally {
      fs.promises.unlink(file).catch(() => {});
    }
  }

  return textResult(lines.join("\n"));
}

async function callTool(tool, args) {
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
    case "wait": {
      const ms = Number(args?.ms ?? 0);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return textResult(`Waited ${ms}ms`);
    }
    case "open_app": {
      const [program] = parsed.cmds[0];
      let child;
      try {
        child = spawn(program, parsed.cmds[0].slice(1), { env: CHILD_ENV, detached: true, stdio: "ignore" });
      } catch (err) {
        return fail(`open_app failed: ${String(err)}`);
      }
      child.on("error", () => { /* the app may fail to launch; the user sees it */ });
      child.unref();
      return textResult(`Opening ${args.name}`);
    }
    default:
      return runAll(parsed.cmds, tool.replace("_", " "));
  }
}

const server = new McpServer({ name: "swarm-computer", version: "1.0.0" });

// Tool input schemas as zod raw shapes (the SDK requires zod schemas for
// `inputSchema`). The shapes are deliberately loose — they describe the
// accepted JSON types to MCP clients — while every actual call is validated
// in `callTool` by the shared `parseToolArgs` validator, the single source
// of truth for ranges, charsets and argv construction.
const XY_SHAPE = {
  x: z.union([z.number(), z.string()]).describe("X coordinate on the desktop (0..4096)."),
  y: z.union([z.number(), z.string()]).describe("Y coordinate on the desktop (0..4096)."),
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
        description: "Inspect display :1 without vision: returns screen geometry, window bounds/centers, and OCR clickable text coordinates (x, y).",
        shape: {
          includeOcr: z.boolean().optional().describe("Include OCR word/line coordinates (default true)."),
          maxItems: z.number().optional().describe("Max OCR targets to return (1..150, default 80)."),
        },
      };
    case "click":
      return { description: "Move the pointer to (x, y) and click the given button.", shape: XY_SHAPE };
    case "double_click":
      return { description: "Move the pointer to (x, y) and double-click.", shape: XY_SHAPE };
    case "move":
      return { description: "Move the pointer to (x, y) without pressing any button.", shape: XY_SHAPE };
    case "drag":
      return { description: "Drag from (x1, y1) to (x2, y2) with the left button pressed.", shape: DRAG_SHAPE };
    case "type":
      return {
        description: "Type text as keyboard input (newlines press Return).",
        shape: { text: z.string().describe("Text to type (max 2000 chars).") },
      };
    case "key":
      return {
        description: "Press a key or key combo, e.g. \"Return\", \"ctrl+l\", \"alt+Tab\".",
        shape: { combo: z.string().describe("Keysym combo (max 64 chars).") },
      };
    case "scroll":
      return { description: "Scroll by wheel steps: positive dy scrolls down, negative up; dx scrolls right/left.", shape: AXIS_SHAPE };
    case "open_app":
      return {
        description:
          "Open a desktop application: browser (Chromium), terminal, files (Thunar), libreoffice (Writer), spreadsheet (LibreOffice Calc), gimp (image editing) or blender (3D).",
        shape: { name: z.enum(OPEN_APP_NAMES) },
      };
    case "wait":
      return {
        description: "Wait for a number of milliseconds (max 300000).",
        shape: { ms: z.union([z.number(), z.string()]).describe("Milliseconds to wait.") },
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
