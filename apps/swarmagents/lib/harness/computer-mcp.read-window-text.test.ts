/**
 * Tests for read_window_text: shared argument validation (validate.mjs),
 * ordered-line selection (parseTesseractText/selectLastLines), the harness
 * risk classification, the window-text capture pipeline with an injected run
 * stub, and one real Xvfb readback test that proves the full scrot/convert/
 * tesseract path returns the text an xterm displays.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import {
  DEFAULT_WINDOW_TEXT_LINES,
  MAX_WINDOW_TEXT_LINES,
  parseTesseractText,
  parseToolArgs,
  parseWmctrlWindows,
  selectLastLines,
  summarizeTool,
} from "../../vm-image-desktop/computer-mcp/validate.mjs";
import { activeWindowTextSection, captureWindowText, ocrPrepArgs } from "../../vm-image-desktop/computer-mcp/window-text.mjs";
import {
  classifyDesktopToolCall,
  computerActionEvent,
  isMutatingComputerCall,
} from "./computer-mcp";

// ---- Validator: read_window_text argument validation ----------------------

test("read_window_text: no args are valid (active window, default maxLines)", () => {
  assert.deepEqual(parseToolArgs("read_window_text", {}), { ok: true, cmds: [] });
  assert.deepEqual(parseToolArgs("read_window_text", { title: "Terminal", maxLines: 20 }), { ok: true, cmds: [] });
});

test("read_window_text: title validates like focus_window (non-empty, <=120 chars)", () => {
  assert.equal(parseToolArgs("read_window_text", { title: "readback" }).ok, true);
  assert.equal(parseToolArgs("read_window_text", { title: "" }).ok, false);
  assert.equal(parseToolArgs("read_window_text", { title: "   " }).ok, false);
  assert.equal(parseToolArgs("read_window_text", { title: "a".repeat(121) }).ok, false);
  assert.equal(parseToolArgs("read_window_text", { title: "a".repeat(120) }).ok, true);
  assert.equal(parseToolArgs("read_window_text", { title: 42 }).ok, false);
  assert.equal(parseToolArgs("read_window_text", { title: null }).ok, true, "null title === absent");
});

test("read_window_text: maxLines must be an integer within [1, 200]", () => {
  assert.equal(parseToolArgs("read_window_text", { maxLines: 1 }).ok, true);
  assert.equal(parseToolArgs("read_window_text", { maxLines: 200 }).ok, true);
  assert.equal(parseToolArgs("read_window_text", { maxLines: "60" }).ok, true);
  assert.equal(parseToolArgs("read_window_text", { maxLines: 0 }).ok, false);
  assert.equal(parseToolArgs("read_window_text", { maxLines: 201 }).ok, false);
  assert.equal(parseToolArgs("read_window_text", { maxLines: -1 }).ok, false);
  assert.equal(parseToolArgs("read_window_text", { maxLines: 1.5 }).ok, false);
  assert.equal(parseToolArgs("read_window_text", { maxLines: "abc" }).ok, false);
});

test("read_window_text: describeSummary mentions title and line count", () => {
  assert.equal(summarizeTool("read_window_text", {}), `Reading window text (last ${DEFAULT_WINDOW_TEXT_LINES} lines)`);
  assert.equal(summarizeTool("read_window_text", { title: "Terminal" }), `Reading window text of "Terminal" (last ${DEFAULT_WINDOW_TEXT_LINES} lines)`);
  assert.equal(summarizeTool("read_window_text", { title: "Terminal", maxLines: 10 }), "Reading window text of \"Terminal\" (last 10 lines)");
});

// ---- Ordered-line selection -------------------------------------------------

test("parseTesseractText: ordered non-empty lines, right-trimmed", () => {
  assert.deepEqual(parseTesseractText("alpha\nbeta  \ngamma\n"), ["alpha", "beta", "gamma"]);
  assert.deepEqual(parseTesseractText("alpha\n\nbeta\n\n"), ["alpha", "beta"]);
  assert.deepEqual(parseTesseractText(""), []);
  assert.deepEqual(parseTesseractText(undefined), []);
});

test("selectLastLines: keeps the last maxLines in order, clamped to [1, 200]", () => {
  const lines = ["a", "b", "c"];
  assert.deepEqual(selectLastLines(lines, 2), ["b", "c"]);
  assert.deepEqual(selectLastLines(lines, 10), ["a", "b", "c"]);
  assert.deepEqual(selectLastLines(lines), lines, "default = 60");
  assert.deepEqual(selectLastLines(lines, 0), ["a", "b", "c"], "0/NaN fall back to the default");
  assert.deepEqual(selectLastLines(lines, -5), ["c"], "negatives clamp to last 1");
  assert.equal(selectLastLines(lines, 500).length, 3, "clamps down to 200");
  assert.deepEqual(selectLastLines([], 3), []);
  assert.deepEqual(selectLastLines(undefined as unknown as string[], 3), []);
  assert.equal(selectLastLines(["x"], MAX_WINDOW_TEXT_LINES + 1).length, 1);
});

test("selectLastLines never mutates the input array", () => {
  const lines = ["a", "b", "c"];
  selectLastLines(lines, 2);
  assert.deepEqual(lines, ["a", "b", "c"]);
});

// ---- Harness risk classification -------------------------------------------

test("read_window_text is read-only: allowed, mutating=false, allowed while user drives", () => {
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__read_window_text", { title: "Terminal" })?.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__read_window_text", { maxLines: 200 })?.level, "allow");
  assert.equal(isMutatingComputerCall("mcp__computer-mcp__read_window_text"), false);
  const userDriving = classifyDesktopToolCall("mcp__computer-mcp__read_window_text", {}, { userDriving: true });
  assert.equal(userDriving?.level, "allow", "observation stays allowed while the user controls the desktop");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__read_window_text", { maxLines: 0 })?.level, "deny");
});

test("computerActionEvent targets the title for read_window_text", () => {
  const event = computerActionEvent("mcp__computer-mcp__read_window_text", { title: "Terminal", maxLines: 20 });
  assert.equal(event.target, "Terminal");
  const noTitle = computerActionEvent("mcp__computer-mcp__read_window_text", {});
  assert.equal(noTitle.target, undefined);
});

// ---- captureWindowText with an injected run stub (no X server needed) -------

type StubResult = { code?: number; stdout?: string; stderr?: string };
function stubRun(handlers: Record<string, StubResult>) {
  const all: Record<string, StubResult> = {
    xdotool: { stdout: "1280 800" },
    wmctrl: { stdout: WMCTRL_LINE },
    ...handlers,
  };
  return async (program: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    const h = all[program] ?? {};
    return { code: h.code ?? 0, stdout: h.stdout ?? "", stderr: h.stderr ?? "" };
  };
}

const WMCTRL_LINE = "0x0040000c 0 110 118 1364 400 grok-bot-vm-254810674 readback";

test("captureWindowText: reads the active window (id match), crops geometry, returns ordered lines", async () => {
  const env = { DISPLAY: ":99" };
  const res = await captureWindowText({
    run: stubRun({
      xdotool: { stdout: "1280 800" },
      wmctrl: { stdout: WMCTRL_LINE },
      scrot: {},
      convert: {},
      tesseract: { stdout: "alpha\nbeta\ngamma\n" },
    }),
    env,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.title, "readback");
    assert.equal(res.geometry, "110,118 1364x400");
    assert.deepEqual(res.lines, ["alpha", "beta", "gamma"]);
    assert.equal(res.truncated, false);
  }
});

test("captureWindowText: maxLines truncates to the tail and flags truncation", async () => {
  const res = await captureWindowText({
    run: stubRun({
      wmctrl: { stdout: WMCTRL_LINE },
      tesseract: { stdout: "a\nb\nc\nd\ne\n" },
    }),
    maxLines: 2,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.lines, ["d", "e"]);
    assert.equal(res.truncated, true);
  }
});

test("captureWindowText: title match selects that window", async () => {
  const twoWindows = `${WMCTRL_LINE}\n0x0060002a 0 5 5 800 600 host other\n`;
  const res = await captureWindowText({
    run: stubRun({
      wmctrl: { stdout: twoWindows },
      tesseract: { stdout: "hello\n" },
    }),
    title: "readback",
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.title, "readback");
});

test("captureWindowText: missing title match is a clear error", async () => {
  const res = await captureWindowText({
    run: stubRun({
      wmctrl: { stdout: WMCTRL_LINE },
    }),
    title: "nope",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /no window with title "nope" found/);
});

test("captureWindowText: no windows => clear error", async () => {
  const res = await captureWindowText({ run: stubRun({ wmctrl: { stdout: "" } }) });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /no window found/);
});

test("captureWindowText: missing tesseract/scrot report a clear error", async () => {
  const noScrot = await captureWindowText({
    run: stubRun({
      wmctrl: { stdout: WMCTRL_LINE },
      scrot: { code: 1, stderr: "spawn scrot ENOENT" },
    }),
  });
  assert.equal(noScrot.ok, false);
  if (!noScrot.ok) assert.match(noScrot.error, /screenshot failed \(is scrot installed\?\)/);

  const noTesseract = await captureWindowText({
    run: stubRun({
      wmctrl: { stdout: WMCTRL_LINE },
      tesseract: { code: 1, stderr: "tesseract: not found" },
    }),
  });
  assert.equal(noTesseract.ok, false);
  if (!noTesseract.ok) assert.match(noTesseract.error, /OCR failed \(is tesseract installed\?\)/);
});

test("activeWindowTextSection formats the describe_screen section (15 lines)", async () => {
  const section = await activeWindowTextSection({
    run: stubRun({
      wmctrl: { stdout: WMCTRL_LINE },
      tesseract: { stdout: "l1\nl2\nl3\n" },
    }),
  });
  assert.ok(section);
  assert.match(section!, /Active window text \(OCR, last 15 lines\): readback @ \(110,118 1364x400\)/);
  assert.match(section!, /l3/);
  const missing = await activeWindowTextSection({ run: stubRun({ wmctrl: { stdout: "" } }) });
  assert.equal(missing, null, "describe_screen omits the section when capture cannot run");
});

// ---- OCR preprocessing (dark terminals) ----------------------------------

test("ocrPrepArgs: inverts dark crops, keeps light ones, always grayscale + 2x", () => {
  assert.deepEqual(ocrPrepArgs("0.08\n"), ["-colorspace", "Gray", "-negate", "-resize", "200%", "-normalize"]);
  assert.deepEqual(ocrPrepArgs("0.93"), ["-colorspace", "Gray", "-resize", "200%", "-normalize"]);
  assert.deepEqual(ocrPrepArgs(""), ["-colorspace", "Gray", "-resize", "200%", "-normalize"]);
  assert.deepEqual(ocrPrepArgs("garbage"), ["-colorspace", "Gray", "-resize", "200%", "-normalize"]);
});

// ---- Real Xvfb readback test ------------------------------------------------

/** Run a program with argv; resolves {code, stdout, stderr} — same contract as server.mjs. */
function run(program: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(program, args, { env: opts.env ?? process.env, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ code: 124, stdout, stderr: `${stderr}timed out`.trim() });
    }, opts.timeoutMs ?? 30_000);
    child.stdout?.on("data", (c) => { stdout += c; });
    child.stderr?.on("data", (c) => { stderr += c; });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `failed to spawn ${program}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

const HAVE_TOOLCHAIN = ["Xvfb", "xterm", "xfwm4", "wmctrl", "xdotool", "scrot", "convert", "tesseract"].every(
  (b) => spawnSync("which", [b]).status === 0,
);

async function waitFor(probe: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return probe();
}

test(
  "real Xvfb: read_window_text reads a light-on-dark xterm line (core-38 dark-terminal fix)",
  { skip: !HAVE_TOOLCHAIN && "needs Xvfb, xterm, xfwm4, wmctrl, xdotool, scrot, imagemagick, tesseract", timeout: 120_000 },
  async (t) => {
    const env = { ...process.env };
    const procs: ChildProcess[] = [];
    t.after(() => {
      for (const p of procs.reverse()) {
        try { p.kill("SIGKILL"); } catch { /* ignore */ }
      }
    });

    // Pick a display whose socket is free (other agents share this box).
    let display = "";
    for (let i = 0; i < 20 && !display; i++) {
      const d = `:${1000 + Math.floor(Math.random() * 200)}`;
      if (!fs.existsSync(`/tmp/.X11-unix/X${d.slice(1)}`)) display = d;
    }
    assert.ok(display, "no free X display socket found");

    const displayEnv = { ...env, DISPLAY: display } as NodeJS.ProcessEnv;

    // Xvfb first, polled ready.
    const xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { env: displayEnv });
    procs.push(xvfb);
    const ready = await waitFor(() => spawnSync("xdotool", ["getdisplaygeometry"], { env: displayEnv }).status === 0, 10_000);
    assert.ok(ready, `Xvfb on ${display} did not become ready`);

    // xterm BEFORE the window manager: xfwm4 only lists frames once a client
    // is mapped. The terminal prints a marker line and idles.
    const xterm = spawn(
      "xterm",
      ["-T", "readback", "-bg", "black", "-fg", "#d0d0d0", "-fa", "Monospace", "-fs", "12", "-geometry", "80x12+100+60", "-e", "sh", "-c", "echo; echo SWARM-READBACK-42; echo; exec sleep 86400"],
      { env: displayEnv },
    );
    procs.push(xterm);
    const mapped = await waitFor(() => spawnSync("xdotool", ["search", "--name", "readback"], { env: displayEnv }).status === 0, 10_000);
    assert.ok(mapped, "xterm window never appeared");

    // WM after the window: now wmctrl lists the frame geometry.
    const wm = spawn("xfwm4", ["--display", display], { env: displayEnv });
    procs.push(wm);
    const listed = await waitFor(
      () => spawnSync("wmctrl", ["-lG"], { env: displayEnv }).stdout.toString().includes("readback"),
      10_000,
    );
    assert.ok(listed, "wmctrl never listed the readback window");

    // Ensure the xterm is the active window (focus it; harmless if not needed).
    spawnSync("xdotool", ["search", "--name", "readback", "windowfocus"], { env: displayEnv });

    const res = await captureWindowText({ run, title: "readback", env: displayEnv });
    assert.equal(res.ok, true, res.ok ? "" : (res as { error: string }).error);
    if (res.ok) {
      assert.equal(res.title, "readback");
      const text = res.lines.join("\n");
      // OCR may insert spaces around hyphens; assert the token sequence.
      assert.match(text, /SWARM[\s-]*READBACK[\s-]*42/i, `expected marker in OCR lines:\n${text}`);
    }

    const active = await captureWindowText({ run, env: displayEnv });
    assert.equal(active.ok, true, active.ok ? "" : (active as { error: string }).error);
    if (active.ok) {
      const text = active.lines.join("\n");
      assert.match(text, /SWARM[\s-]*READBACK[\s-]*42/i, `active-window path should also read the marker:\n${text}`);
    }
  },
);
