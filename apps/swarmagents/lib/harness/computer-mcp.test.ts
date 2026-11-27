/**
 * Tests for the desktop computer-use surface: the shared MCP validator
 * (vm-image-desktop/computer-mcp/validate.mjs — the exact module the server
 * executes), the harness risk classification for desktop tool calls, and the
 * human-readable summaries carried by computer.action telemetry.
 *
 * The central security invariant: every validated tool call yields *argv
 * arrays* (never a shell string), so no argument — text, keys, coordinates,
 * app names — can ever be interpreted as a command. The injection cases
 * below exercise exactly that.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  OPEN_APP_NAMES,
  findTextTarget,
  parseTesseractTsv,
  parseToolArgs,
  parseWmctrlWindows,
  summarizeTool,
} from "../../vm-image-desktop/computer-mcp/validate.mjs";
import {
  classifyDesktopToolCall,
  classifyDesktopToolCallAsync,
  computerActionEvent,
  describeDesktopAction,
  desktopMcpTool,
  isDesktopMcpCall,
  isRawScreenshotCall,
  parseMcpToolName,
} from "./computer-mcp";
import type { RiskDecision } from "./risk";

// ---- Tool-name parsing -----------------------------------------------------

test("parseMcpToolName recognizes mcp__server__tool names", () => {
  assert.deepEqual(parseMcpToolName("mcp__computer-mcp__click"), { server: "computer-mcp", tool: "click" });
  assert.deepEqual(parseMcpToolName("mcp__playwright-mcp__browser_navigate"), {
    server: "playwright-mcp",
    tool: "browser_navigate",
  });
  // Non-desktop MCP servers parse the same way; the desktop check is separate.
  assert.deepEqual(parseMcpToolName("mcp__roles__set_role"), { server: "roles", tool: "set_role" });
  assert.equal(parseMcpToolName("Bash"), null);
  assert.equal(parseMcpToolName(""), null);
});

test("isDesktopMcpCall / desktopMcpTool only match the desktop servers", () => {
  assert.equal(isDesktopMcpCall("mcp__computer-mcp__screenshot"), true);
  assert.equal(isDesktopMcpCall("mcp__playwright-mcp__browser_navigate"), true);
  assert.equal(isDesktopMcpCall("mcp__browser-mcp__browser_navigate"), true);
  assert.equal(isDesktopMcpCall("mcp__roles__set_role"), false);
  assert.equal(isDesktopMcpCall("Bash"), false);
  assert.equal(desktopMcpTool("mcp__computer-mcp__type"), "type");
  assert.equal(desktopMcpTool("mcp__roles__set_role"), null);
});

// ---- Validator: argv arrays, never shell strings ---------------------------

test("click / double_click / move produce plain xdotool argv", () => {
  // Moves and clicks chain into one xdotool argv (valid command syntax), never
  // a shell string.
  assert.deepEqual(parseToolArgs("click", { x: 100, y: 200 }), {
    ok: true,
    cmds: [["mousemove", "100", "200", "click", "1"]],
  });
  assert.deepEqual(parseToolArgs("click", { x: 100, y: 200, button: 3 }), {
    ok: true,
    cmds: [["mousemove", "100", "200", "click", "3"]],
  });
  assert.deepEqual(parseToolArgs("double_click", { x: "10", y: "20" }), {
    ok: true,
    cmds: [["mousemove", "10", "20", "click", "--repeat", "2", "--delay", "60", "1"]],
  });
  assert.deepEqual(parseToolArgs("move", { x: 7, y: 8 }), {
    ok: true,
    cmds: [["mousemove", "7", "8"]],
  });
});

test("drag produces press-move-release argv", () => {
  const parsed = parseToolArgs("drag", { x1: 0, y1: 0, x2: 500, y2: 500 });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.cmds, [
    ["mousemove", "0", "0"],
    ["mousedown", "1"],
    ["mousemove", "500", "500"],
    ["mouseup", "1"],
  ]);
});

test("type produces argv with the text as a single element (newlines -> Return)", () => {
  // Short ASCII text types via keys by default — unchanged behavior.
  assert.deepEqual(parseToolArgs("type", { text: "hello" }), {
    ok: true,
    cmds: [["type", "--delay", "15", "hello"]],
  });
  // Explicit keys keeps the classic per-line keyboard argv.
  const multilineKeys = parseToolArgs("type", { text: "a\nb", mode: "keys" });
  assert.equal(multilineKeys.ok, true);
  assert.deepEqual(multilineKeys.cmds, [
    ["type", "--delay", "15", "a"],
    ["key", "Return"],
    ["type", "--delay", "15", "b"],
  ]);
  // Auto mode routes multiline text to paste instead (see
  // computer-mcp.type.test.ts for the full mode matrix).
  const multiline = parseToolArgs("type", { text: "a\nb" });
  assert.equal(multiline.ok, true);
  assert.deepEqual(multiline.cmds, [["@paste", "a\nb"]]);
});

test("key produces argv; combos are charset-limited", () => {
  assert.deepEqual(parseToolArgs("key", { combo: "ctrl+l" }), { ok: true, cmds: [["key", "ctrl+l"]] });
  assert.deepEqual(parseToolArgs("key", { combo: "Return" }), { ok: true, cmds: [["key", "Return"]] });
  // Shell metacharacters / spaces are not valid keysym combos.
  assert.equal(parseToolArgs("key", { combo: "rm -rf /" }).ok, false);
  assert.equal(parseToolArgs("key", { combo: "$(id)" }).ok, false);
  assert.equal(parseToolArgs("key", { combo: "a;b" }).ok, false);
  assert.equal(parseToolArgs("key", {}).ok, false);
});

test("scroll maps deltas to wheel-button repeats, capped", () => {
  assert.deepEqual(parseToolArgs("scroll", { dx: 0, dy: 5 }), {
    ok: true,
    cmds: [["click", "--repeat", "5", "--delay", "30", "5"]],
  });
  const up = parseToolArgs("scroll", { dx: 0, dy: -3 });
  assert.deepEqual(up.cmds, [["click", "--repeat", "3", "--delay", "30", "4"]]);
  const both = parseToolArgs("scroll", { dx: -2, dy: 1 });
  assert.deepEqual(both.cmds, [
    ["click", "--repeat", "1", "--delay", "30", "5"],
    ["click", "--repeat", "2", "--delay", "30", "6"],
  ]);
  assert.equal(parseToolArgs("scroll", { dx: 0, dy: 0 }).ok, false);
  assert.equal(parseToolArgs("scroll", { dx: 1 }).ok, false); // dy missing
});

test("open_app only launches allowlisted apps", () => {
  assert.deepEqual(parseToolArgs("open_app", { name: "browser" }), {
    ok: true,
    // --remote-debugging-port=9222 opens the CDP debug port so the Browser
    // tab can mirror this Chromium (l10); plain Chromium accepts the flag.
    cmds: [["chromium", "--new-window", "--remote-debugging-port=9222"]],
  });
  assert.deepEqual(parseToolArgs("open_app", { name: "terminal" }), {
    ok: true,
    cmds: [["xfce4-terminal"]],
  });
  assert.deepEqual(parseToolArgs("open_app", { name: "files" }), {
    ok: true,
    cmds: [["thunar"]],
  });
  assert.deepEqual(parseToolArgs("open_app", { name: "libreoffice" }), {
    ok: true,
    cmds: [["lowriter"]],
  });
  assert.deepEqual(parseToolArgs("open_app", { name: "gimp" }), {
    ok: true,
    cmds: [["gimp"]],
  });
  assert.deepEqual(parseToolArgs("open_app", { name: "blender" }), {
    ok: true,
    cmds: [["blender"]],
  });
  assert.deepEqual(parseToolArgs("open_app", { name: "spreadsheet" }), {
    ok: true,
    cmds: [["localc"]],
  });
  // The exported name list (used for the server's zod enum) matches the allowlist exactly.
  for (const name of OPEN_APP_NAMES) assert.equal(parseToolArgs("open_app", { name }).ok, true, name);
  assert.equal(summarizeTool("open_app", { name: "gimp" }), "Opening gimp");
  assert.equal(summarizeTool("open_app", { name: "toString" }), "Opening app");
  assert.equal(parseToolArgs("open_app", { name: "toString" }).ok, false);
  assert.equal(parseToolArgs("open_app", { name: "constructor" }).ok, false);
  assert.equal(parseToolArgs("open_app", { name: "bash" }).ok, false);
  assert.equal(parseToolArgs("open_app", { name: "../../bin/sh" }).ok, false);
  assert.equal(parseToolArgs("open_app", {}).ok, false);
});

test("screenshot / wait have no commands", () => {
  assert.deepEqual(parseToolArgs("screenshot", {}), { ok: true, cmds: [] });
  assert.deepEqual(parseToolArgs("wait", { ms: 100 }), { ok: true, cmds: [] });
  assert.equal(parseToolArgs("wait", { ms: -1 }).ok, false);
  assert.equal(parseToolArgs("wait", { ms: 999999999 }).ok, false);
});

test("injection-shaped arguments are rejected or stay inert argv", () => {
  // Shell metacharacters in coordinates are not integers -> rejected.
  assert.equal(parseToolArgs("click", { x: "1; echo pwned", y: 5 }).ok, false);
  assert.equal(parseToolArgs("click", { x: 1, y: "yes" }).ok, false);
  // Out-of-range / negative coordinates are rejected.
  assert.equal(parseToolArgs("click", { x: -5, y: 0 }).ok, false);
  assert.equal(parseToolArgs("click", { x: 99999, y: 0 }).ok, false);
  // Buttons outside 1..7 are rejected.
  assert.equal(parseToolArgs("click", { x: 1, y: 1, button: 9 }).ok, false);
  // Text is allowed to contain shell punctuation, but it arrives as one argv
  // element — xdotool types the literal characters, nothing is executed.
  const text = parseToolArgs("type", { text: "x; rm -rf / && echo pwned" });
  assert.equal(text.ok, true);
  assert.ok(text.cmds.every((argv) => argv.every((arg) => typeof arg === "string")));
  assert.deepEqual(text.cmds, [["type", "--delay", "15", "x; rm -rf / && echo pwned"]]);
  // Control characters cannot be typed.
  assert.equal(parseToolArgs("type", { text: "a\u0000b" }).ok, false);
  assert.equal(parseToolArgs("type", { text: "a\u001bb" }).ok, false);
  // Unknown tools never produce commands.
  assert.equal(parseToolArgs("delete_everything", {}).ok, false);
});

// ---- Risk classification ---------------------------------------------------

test("classifyDesktopToolCall: computer-mcp tools pass the shared validator gates", () => {
  const call = (name: string, input: unknown): RiskDecision => classifyDesktopToolCall(name, input)!;
  assert.equal(call("mcp__computer-mcp__click", { x: 1, y: 2 }).level, "allow");
  assert.equal(call("mcp__computer-mcp__screenshot", {}).level, "allow");
  assert.equal(call("mcp__computer-mcp__type", { text: "hello" }).level, "allow");
  // Malformed arguments are denied — the server would reject them anyway.
  const bad = call("mcp__computer-mcp__click", { x: -1, y: 2 });
  assert.equal(bad.level, "deny");
  assert.match(bad.reason, /invalid desktop action/);
  assert.equal(call("mcp__computer-mcp__open_app", { name: "sh" }).level, "deny");
});

test("classifyDesktopToolCall: browser navigation allows only explicit loopback for local previews", () => {
  const nav = (url: string): RiskDecision => classifyDesktopToolCall("mcp__playwright-mcp__browser_navigate", { url })!;
  assert.equal(nav("https://github.com/owner/repo").level, "allow");
  assert.equal(nav("https://example.com").level, "allow");
  assert.equal(nav("http://localhost:8080/app").level, "allow");
  assert.equal(nav("http://127.0.0.1/x").level, "allow");
  assert.equal(nav("https://[::1]/").level, "allow");
  assert.equal(nav("http://10.0.0.5/").level, "deny");
  assert.equal(nav("http://192.168.1.10/").level, "deny");
  assert.equal(nav("file:///etc/passwd").level, "deny");
  assert.equal(nav("ftp://localhost/file").level, "deny");
  assert.equal(classifyDesktopToolCall("mcp__browser-mcp__browser_navigate", { url: "http://127.0.0.1:5173" })!.level, "allow");
});

test("classifyDesktopToolCall: other playwright actions and non-desktop calls fall through", () => {
  assert.equal(classifyDesktopToolCall("mcp__playwright-mcp__browser_click", { ref: "x" })!.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__playwright-mcp__browser_snapshot", {})!.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__playwright-mcp__browser_navigate", {})!.level, "allow");
  assert.equal(classifyDesktopToolCall("Bash", { command: "ls" }), null);
  assert.equal(classifyDesktopToolCall("Read", { file_path: "x" }), null);
  assert.equal(classifyDesktopToolCall("mcp__roles__set_role", { role_id: "x" }), null);
});

test("classifyDesktopToolCall normalizes loopback but still blocks reserved hostnames (b9)", () => {
  const nav = (url: string): RiskDecision => classifyDesktopToolCall("mcp__playwright-mcp__browser_navigate", { url })!;
  assert.equal(nav("http://localhost./").level, "allow");
  assert.equal(nav("http://LOCALHOST./").level, "allow");
  assert.equal(nav("http://localhost.localdomain/").level, "deny");
  assert.equal(nav("http://metadata.google.internal/").level, "deny");
  assert.equal(nav("https://example.com").level, "allow");
});

test("classifyDesktopToolCallAsync runs DNS preflight (b9)", async () => {
  const lookup = async (host: string): Promise<string[]> => {
    const map: Record<string, string[]> = {
      "localtest.me": ["127.0.0.1"],
      "127.0.0.1.nip.io": ["127.0.0.1"],
      "example.com": ["93.184.216.34"],
    };
    return map[host] ?? [];
  };
  const nav = (url: string) =>
    classifyDesktopToolCallAsync("mcp__playwright-mcp__browser_navigate", { url }, lookup);

  assert.equal((await nav("http://localhost./"))!.level, "allow");
  assert.equal((await nav("http://localtest.me/"))!.level, "deny");
  assert.equal((await nav("http://127.0.0.1.nip.io/"))!.level, "deny");
  assert.equal((await nav("https://example.com"))!.level, "allow");
  assert.equal((await nav("http://127.0.0.1/"))!.level, "allow");
});

// ---- Text-desktop mode: raw screenshots are denied, text inspection is not -

test("isRawScreenshotCall matches only the image-returning screenshot tools", () => {
  assert.equal(isRawScreenshotCall("mcp__computer-mcp__screenshot"), true);
  // The real @playwright/mcp screenshot tool (catalog: connectors.json).
  assert.equal(isRawScreenshotCall("mcp__playwright-mcp__browser_take_screenshot"), true);
  assert.equal(isRawScreenshotCall("mcp__playwright-mcp__browser_screen_capture"), true);
  assert.equal(isRawScreenshotCall("mcp__playwright-mcp__browser_screenshot"), true);
  assert.equal(isRawScreenshotCall("mcp__browser-mcp__browser_screenshot"), true);
  // The text inspection paths are not screenshots.
  assert.equal(isRawScreenshotCall("mcp__computer-mcp__describe_screen"), false);
  assert.equal(isRawScreenshotCall("mcp__playwright-mcp__browser_snapshot"), false);
  assert.equal(isRawScreenshotCall("mcp__playwright-mcp__browser_accessible_snapshot"), false);
  assert.equal(isRawScreenshotCall("mcp__computer-mcp__click"), false);
  assert.equal(isRawScreenshotCall("mcp__roles__set_role"), false);
  assert.equal(isRawScreenshotCall("Bash"), false);
});

test("classifyDesktopToolCall denies raw screenshots in text-desktop mode", () => {
  const textDesktop = { textDesktop: true };
  const shot = classifyDesktopToolCall("mcp__computer-mcp__screenshot", {}, textDesktop)!;
  assert.equal(shot.level, "deny");
  assert.match(shot.reason, /describe_screen/);

  const browserShot = classifyDesktopToolCall(
    "mcp__playwright-mcp__browser_take_screenshot",
    {},
    textDesktop,
  )!;
  assert.equal(browserShot.level, "deny");
  assert.match(browserShot.reason, /browser_snapshot/);

  // The text paths stay open in text-desktop mode: describe_screen, the
  // accessibility snapshots, and the input tools.
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__describe_screen", {}, textDesktop)!.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__playwright-mcp__browser_snapshot", {}, textDesktop)!.level, "allow");
  assert.equal(
    classifyDesktopToolCall("mcp__playwright-mcp__browser_accessible_snapshot", {}, textDesktop)!.level,
    "allow",
  );
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__click", { x: 1, y: 2 }, textDesktop)!.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__type", { text: "hi" }, textDesktop)!.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__key", { combo: "Return" }, textDesktop)!.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__scroll", { dx: 0, dy: 3 }, textDesktop)!.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__open_app", { name: "browser" }, textDesktop)!.level, "allow");

  // Without the flag nothing changes: screenshots are allowed as before.
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__screenshot", {})!.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__playwright-mcp__browser_take_screenshot", {})!.level, "allow");
});

test("classifyDesktopToolCallAsync denies raw screenshots in text-desktop mode", async () => {
  const shot = await classifyDesktopToolCallAsync("mcp__computer-mcp__screenshot", {}, undefined, {
    textDesktop: true,
  });
  assert.equal(shot!.level, "deny");
  assert.match(shot!.reason, /describe_screen/);

  const browserShot = await classifyDesktopToolCallAsync(
    "mcp__browser-mcp__browser_screenshot",
    {},
    undefined,
    { textDesktop: true },
  );
  assert.equal(browserShot!.level, "deny");
  assert.match(browserShot!.reason, /browser_snapshot/);

  // Text inspection still allowed through the async classifier.
  const described = await classifyDesktopToolCallAsync("mcp__computer-mcp__describe_screen", {}, undefined, {
    textDesktop: true,
  });
  assert.equal(described!.level, "allow");
});

// ---- Human-readable summaries (computer.action telemetry) -------------------

test("describeDesktopAction summarizes computer-mcp calls readably", () => {
  assert.equal(describeDesktopAction("mcp__computer-mcp__click", { x: 10, y: 20 }), "Clicking at (10, 20)");
  assert.equal(describeDesktopAction("mcp__computer-mcp__click", { x: 1, y: 1, button: 3 }), "Right-clicking at (1, 1)");
  assert.equal(describeDesktopAction("mcp__computer-mcp__double_click", { x: 1, y: 1 }), "Double-clicking at (1, 1)");
  assert.equal(describeDesktopAction("mcp__computer-mcp__move", { x: 1, y: 1 }), "Moving pointer to (1, 1)");
  assert.equal(describeDesktopAction("mcp__computer-mcp__type", { text: "hello" }), "Typing (5 chars)");
  assert.equal(describeDesktopAction("mcp__computer-mcp__key", { combo: "ctrl+l" }), "Pressing ctrl+l");
  assert.equal(describeDesktopAction("mcp__computer-mcp__open_app", { name: "browser" }), "Opening browser");
  assert.equal(describeDesktopAction("mcp__computer-mcp__screenshot", {}), "Taking a screenshot");
  assert.equal(describeDesktopAction("mcp__computer-mcp__scroll", { dx: 0, dy: 2 }), "Scrolling down");
  assert.equal(describeDesktopAction("mcp__computer-mcp__wait", { ms: 500 }), "Waiting 500ms");
});

test("compound desktop tools: validation, risk gate, findTextTarget, and telemetry", () => {
  // click_text
  assert.equal(parseToolArgs("click_text", { text: "Submit" }).ok, true);
  assert.equal(parseToolArgs("click_text", { text: "" }).ok, false);
  assert.equal(parseToolArgs("click_text", { text: "Submit", button: 9 }).ok, false);
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__click_text", { text: "Submit" })?.level, "allow");
  assert.equal(describeDesktopAction("mcp__computer-mcp__click_text", { text: "Submit" }), 'Clicking "Submit"');
  assert.equal(computerActionEvent("mcp__computer-mcp__click_text", { text: "Submit" }).target, "Submit");

  // wait_for_text & wait_for_screen_change
  assert.equal(parseToolArgs("wait_for_text", { text: "Done", timeoutMs: 5000, pollMs: 250 }).ok, true);
  assert.equal(parseToolArgs("wait_for_text", { text: "Done", timeoutMs: 50 }).ok, false);
  assert.equal(parseToolArgs("wait_for_screen_change", { timeoutMs: 3000 }).ok, true);
  assert.equal(parseToolArgs("wait_for_screen_change", { pollMs: 50 }).ok, false);
  assert.equal(describeDesktopAction("mcp__computer-mcp__wait_for_screen_change", {}), "Waiting for screen change");

  // clipboard_get & clipboard_set (never leaks clipboard content into telemetry)
  assert.equal(parseToolArgs("clipboard_get", { selection: "clipboard" }).ok, true);
  assert.equal(parseToolArgs("clipboard_get", { selection: "invalid" }).ok, false);
  assert.equal(parseToolArgs("clipboard_set", { text: "secret-token" }).ok, true);
  assert.equal(parseToolArgs("clipboard_set", { text: "" }).ok, false);
  assert.equal(describeDesktopAction("mcp__computer-mcp__clipboard_set", { text: "secret-token" }), "Setting clipboard (12 chars)");
  const clipEv = computerActionEvent("mcp__computer-mcp__clipboard_set", { text: "secret-token" });
  assert.equal(clipEv.text, undefined);
  assert.ok(!JSON.stringify(clipEv).includes("secret-token"));

  // focus_window
  assert.equal(parseToolArgs("focus_window", { title: "Terminal" }).ok, true);
  assert.deepEqual(parseToolArgs("focus_window", { title: "Terminal" }).cmds, [["-a", "Terminal"]]);
  assert.equal(parseToolArgs("focus_window", { title: "" }).ok, false);
  assert.equal(computerActionEvent("mcp__computer-mcp__focus_window", { title: "Terminal" }).target, "Terminal");

  // findTextTarget prefers exact match, falls back to case-insensitive substring
  const targets = [
    { text: "Save As...", x: 0, y: 0, w: 40, h: 20, cx: 20, cy: 10 },
    { text: "Save", x: 50, y: 0, w: 30, h: 20, cx: 65, cy: 10 },
  ];
  assert.equal(findTextTarget(targets, "save")?.text, "Save");
  assert.equal(findTextTarget(targets, "as")?.text, "Save As...");
  assert.equal(findTextTarget(targets, "as", { exact: true }), null);
});

test("classifyDesktopToolCall denies mutating desktop input when userDriving is active, keeping inspection tools allowed", () => {
  const click = classifyDesktopToolCall("mcp__computer-mcp__click", { x: 100, y: 200 }, { userDriving: true });
  assert.equal(click?.level, "deny");
  assert.equal(click?.reason, "the user is controlling the desktop; wait or call describe_screen");

  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__describe_screen", {}, { userDriving: true })?.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__screenshot", {}, { userDriving: true })?.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__inspect_ui", {}, { userDriving: true })?.level, "allow");
});

test("describeDesktopAction summarizes playwright calls readably", () => {
  assert.equal(
    describeDesktopAction("mcp__playwright-mcp__browser_navigate", { url: "https://github.com/foo" }),
    "Opening github.com",
  );
  assert.equal(describeDesktopAction("mcp__playwright-mcp__browser_navigate", {}), "Opening a new tab");
  assert.equal(describeDesktopAction("mcp__playwright-mcp__browser_snapshot", {}), "Reading the page");
  assert.equal(
    describeDesktopAction("mcp__playwright-mcp__browser_type", { text: "search term" }),
    "Typing (11 chars)",
  );
  assert.equal(describeDesktopAction("mcp__playwright-mcp__browser_press_key", { key: "Enter" }), "Pressing Enter");
  assert.equal(describeDesktopAction("mcp__playwright-mcp__browser_mouse_wheel", { deltaY: 100 }), "Scrolling the page");
  // Non-desktop call: falls back to a readable label rather than crashing.
  assert.equal(describeDesktopAction("mcp__roles__set_role", { role_id: "x" }), "Set role");
});

test("summarizeTool (server side) stays consistent with the harness summaries", () => {
  assert.equal(summarizeTool("click", { x: 10, y: 20 }), "Clicking at (10, 20)");
  assert.equal(summarizeTool("type", { text: "hi" }), "Typing (2 chars)");
  // Typed content never appears in a summary, however long: count only.
  assert.equal(summarizeTool("type", { text: "x".repeat(100) }), "Typing (100 chars)");
  assert.equal(summarizeTool("key", { combo: "Return" }), "Pressing Return");
  assert.equal(summarizeTool("open_app", { name: "browser" }), "Opening browser");
  assert.equal(summarizeTool("scroll", { dx: 0, dy: -4 }), "Scrolling up");
  assert.equal(summarizeTool("describe_screen", {}), "Reading screen layout and clickable text");
});

test("non-vision desktop helpers parse describe_screen, wmctrl windows, and Tesseract TSV coordinates", () => {
  assert.deepEqual(parseToolArgs("describe_screen", {}), { ok: true, cmds: [] });
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__describe_screen", {})?.level, "allow");

  const windows = parseWmctrlWindows(
    "0x01a00003  0 10   28   1580 840  node Chromium\n0x02400001  0 0    0    1600 28   node xfce4-panel\n",
  );
  assert.equal(windows.length, 2);
  assert.equal(windows[0].title, "Chromium");
  assert.deepEqual({ cx: windows[0].cx, cy: windows[0].cy }, { cx: 800, cy: 448 });

  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t100\t200\t40\t16\t92\tSign",
    "5\t1\t1\t1\t1\t2\t148\t200\t32\t16\t95\tIn",
    "5\t1\t2\t1\t1\t1\t10\t10\t20\t10\t12\tnoise",
  ].join("\n");
  const targets = parseTesseractTsv(tsv, 10);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].text, "Sign In");
  assert.deepEqual({ cx: targets[0].cx, cy: targets[0].cy }, { cx: 140, cy: 208 });
});
