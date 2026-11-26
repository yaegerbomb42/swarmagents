// Shared validation for the SwarmAgents computer-use MCP server.
//
// This module is deliberately dependency-free and side-effect free: it turns
// a tool name + raw JSON arguments into a list of *argv arrays* (safe to pass
// to child_process.spawn) or a human-readable summary of the action. It is
// the single source of truth for argument validation used by both the MCP
// server (server.mjs) and the harness risk/telemetry layer
// (lib/harness/computer-mcp.ts), so the exact same rules that gate a call
// are the ones the server executes.
//
// Security invariant: every command is produced as an argv array — never a
// shell string. Values (text, keys, coordinates) are always separate argv
// elements, so metacharacters cannot be interpreted by a shell.

/** Names accepted by open_app (keys of the fixed launch allowlist below). */
export const OPEN_APP_NAMES = Object.freeze(["browser", "terminal", "files", "libreoffice", "spreadsheet", "gimp", "blender"]);

/** Tools this server exposes. */
export const COMPUTER_TOOLS = Object.freeze([
  "screenshot",
  "describe_screen",
  "inspect_ui",
  "click",
  "double_click",
  "click_text",
  "move",
  "drag",
  "type",
  "key",
  "scroll",
  "open_app",
  "focus_window",
  "wait",
  "wait_for_text",
  "wait_for_screen_change",
  "clipboard_get",
  "clipboard_set",
]);

/** Screen dimension cap; anything beyond is rejected (not clamped). */
const MAX_SCREEN_DIM = 4096;
/** Typing cap, characters. */
const MAX_TYPE_LEN = 2000;
/** Clipboard write cap, characters. */
const MAX_CLIPBOARD_LEN = 20_000;
/** Query/title cap for click_text, wait_for_text, focus_window. */
const MAX_QUERY_LEN = 120;
/** Key-combo charset: printable keysym names plus modifiers, no shell chars. */
const KEY_COMBO_RE = /^[A-Za-z0-9_+\-]+$/;
const MAX_KEY_COMBO_LEN = 64;
/** Caps for scroll steps (one wheel click per step) and wait. */
const MAX_SCROLL_STEPS = 200;
const MAX_WAIT_MS = 300 * 1000;
/** inspect_ui caps: returned elements, app/query filter length. */
const MAX_UI_ITEMS = 300;
const DEFAULT_UI_ITEMS = 120;
const MAX_UI_FILTER_LEN = 64;
/** Filter charset: letters, digits, space and a few punctuation marks (no shell/control chars). */
const UI_FILTER_RE = /^[\p{L}\p{N} ._:()'&,\-]*$/u;
const MAX_POLL_WAIT_MS = 60 * 1000;
/** Apps the agent may open; the fixed mapping is the allowlist. */
const OPEN_APPS = Object.freeze({
  browser: Object.freeze(["chromium", "--new-window"]),
  terminal: Object.freeze(["xfce4-terminal"]),
  files: Object.freeze(["thunar"]),
  libreoffice: Object.freeze(["lowriter"]),
  spreadsheet: Object.freeze(["localc"]),
  gimp: Object.freeze(["gimp"]),
  blender: Object.freeze(["blender"]),
});

/**
 * An integer argument: a number or a numeric string, coerced. NaN, Infinity
 * and non-numeric strings are rejected. Returns null on anything invalid.
 */
function toInt(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** Coerce a coordinate argument: integer within [0, max]. Returns null when invalid. */
function coord(value, max) {
  const n = toInt(value);
  if (n === null || n < 0 || n > max) return null;
  return n;
}

/** Coerce a mouse button: xdotool button number 1..7 (1 = left, 2 = middle, 3 = right). */
function button(value) {
  if (value === undefined || value === null) return 1;
  const n = toInt(value);
  if (n === null || n < 1 || n > 7) return null;
  return n;
}

function invalid(error) {
  return { ok: false, error, cmds: [] };
}

function ok(cmds) {
  return { ok: true, cmds };
}

/** Validate a `click`-family call; returns the xdotool argv. */
function clickArgs(args, { double }) {
  const x = coord(args.x, MAX_SCREEN_DIM);
  const y = coord(args.y, MAX_SCREEN_DIM);
  if (x === null || y === null) return invalid("x and y must be integers within [0, 4096].");
  const b = button(args.button);
  if (b === null) return invalid("button must be an integer 1..7.");
  const cmd = ["mousemove", String(x), String(y)];
  if (double) {
    cmd.push("click", "--repeat", "2", "--delay", "60", String(b));
  } else {
    cmd.push("click", String(b));
  }
  return ok([cmd]);
}

/** Validate a `move` call. */
function moveArgs(args) {
  const x = coord(args.x, MAX_SCREEN_DIM);
  const y = coord(args.y, MAX_SCREEN_DIM);
  if (x === null || y === null) return invalid("x and y must be integers within [0, 4096].");
  return ok([["mousemove", String(x), String(y)]]);
}

/** Validate a `drag` call (press, move, release). */
function dragArgs(args) {
  const x1 = coord(args.x1, MAX_SCREEN_DIM);
  const y1 = coord(args.y1, MAX_SCREEN_DIM);
  const x2 = coord(args.x2, MAX_SCREEN_DIM);
  const y2 = coord(args.y2, MAX_SCREEN_DIM);
  if (x1 === null || y1 === null || x2 === null || y2 === null) {
    return invalid("x1, y1, x2, y2 must be integers within [0, 4096].");
  }
  return ok([
    ["mousemove", String(x1), String(y1)],
    ["mousedown", "1"],
    ["mousemove", String(x2), String(y2)],
    ["mouseup", "1"],
  ]);
}

/** Validate a `type` call. Newlines become Return key presses. */
function typeArgs(args) {
  const text = typeof args.text === "string" ? args.text : "";
  if (text.length > MAX_TYPE_LEN) return invalid(`text too long (max ${MAX_TYPE_LEN} characters).`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    return invalid("text contains control characters that cannot be typed.");
  }
  const lines = text.split("\n");
  const cmds = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) cmds.push(["type", "--delay", "15", lines[i]]);
    if (i < lines.length - 1) cmds.push(["key", "Return"]);
  }
  if (cmds.length === 0) return invalid("text is empty.");
  return ok(cmds);
}

/** Validate a `key` call (a single combo like "ctrl+l" or "Return"). */
function keyArgs(args) {
  const combo = typeof args.combo === "string" ? args.combo : "";
  if (!combo || combo.length > MAX_KEY_COMBO_LEN || !KEY_COMBO_RE.test(combo)) {
    return invalid("combo must be a keysym combo like \"ctrl+l\" or \"Return\".");
  }
  return ok([["key", combo]]);
}

/** Validate a `scroll` call; maps deltas to wheel-button clicks with repeats. */
function scrollArgs(args) {
  const dx = toInt(args.dx);
  const dy = toInt(args.dy);
  if (dx === null || dy === null) return invalid("dx and dy must be integers.");
  if (dx === 0 && dy === 0) return invalid("dx and dy cannot both be 0.");
  const cmds = [];
  const add = (buttonName, steps) => {
    if (steps > 0) cmds.push(["click", "--repeat", String(Math.min(steps, MAX_SCROLL_STEPS)), "--delay", "30", buttonName]);
  };
  if (dy > 0) add("5", dy); // down
  if (dy < 0) add("4", -dy); // up
  if (dx > 0) add("7", dx); // right
  if (dx < 0) add("6", -dx); // left
  if (cmds.length === 0) return invalid("scroll deltas are out of range.");
  return ok(cmds);
}

/** Validate an `open_app` call; the name maps to a fixed launch argv. */
function openAppArgs(args) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  // Own keys only: "toString"/"constructor" must not resolve through the prototype.
  const launch = Object.prototype.hasOwnProperty.call(OPEN_APPS, name) ? OPEN_APPS[name] : undefined;
  if (!launch) return invalid(`name must be one of: ${Object.keys(OPEN_APPS).join(", ")}.`);
  return ok([launch]);
}

/** Validate a `wait` call. */
function waitArgs(args) {
  const ms = toInt(args.ms);
  if (ms === null || ms < 0 || ms > MAX_WAIT_MS) {
    return invalid(`ms must be an integer within [0, ${MAX_WAIT_MS}].`);
  }
  return ok([]);
}

/** Validate an optional inspect_ui text filter; returns "" when absent, null when invalid. */
function uiFilter(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const v = value.trim();
  // No leading "-": the value is a helper argv element and must never read as a flag.
  if (v.length > MAX_UI_FILTER_LEN || !UI_FILTER_RE.test(v) || v.startsWith("-")) return null;
  return v;
}

/**
 * Validate an `inspect_ui` call. Produces the argument list for the AT-SPI2
 * dump helper (atspi_dump.py; the server prepends `python3 <path>`). The
 * `query`/`role` filters are applied to the parsed result, not passed on.
 */
function inspectUiArgs(args) {
  const app = uiFilter(args.app);
  if (app === null) return invalid(`app must be a plain name filter (max ${MAX_UI_FILTER_LEN} chars).`);
  const query = uiFilter(args.query);
  if (query === null) return invalid(`query must be plain text (max ${MAX_UI_FILTER_LEN} chars).`);
  const role = uiFilter(args.role);
  if (role === null) return invalid(`role must be a plain role name (max ${MAX_UI_FILTER_LEN} chars).`);
  let max = DEFAULT_UI_ITEMS;
  if (args.maxItems !== undefined && args.maxItems !== null) {
    const n = toInt(args.maxItems);
    if (n === null || n < 1 || n > MAX_UI_ITEMS) return invalid(`maxItems must be an integer within [1, ${MAX_UI_ITEMS}].`);
    max = n;
  }
  // Filters narrow the result after the walk, so walk wider than we return.
  const walkMax = query || role ? MAX_UI_ITEMS + 100 : max;
  const argv = ["--max", String(walkMax)];
  if (app) argv.push("--app", app);
  return ok([argv]);
}

function queryTextArgs(args, field = "text") {
  const raw = typeof args[field] === "string" ? args[field].trim() : "";
  if (!raw || raw.length > MAX_QUERY_LEN) {
    return invalid(`${field} must be a non-empty string (max ${MAX_QUERY_LEN} chars).`);
  }
  return { ok: true, value: raw };
}

function clickTextArgs(args) {
  const q = queryTextArgs(args, "text");
  if (!q.ok) return q;
  const b = button(args.button);
  if (b === null) return invalid("button must be an integer 1..7.");
  return ok([]);
}

function waitPollArgs(args, { requireText }) {
  if (requireText) {
    const q = queryTextArgs(args, "text");
    if (!q.ok) return q;
  }
  if (args.timeoutMs !== undefined) {
    const t = toInt(args.timeoutMs);
    if (t === null || t < 100 || t > MAX_POLL_WAIT_MS) {
      return invalid(`timeoutMs must be an integer within [100, ${MAX_POLL_WAIT_MS}].`);
    }
  }
  if (args.pollMs !== undefined) {
    const p = toInt(args.pollMs);
    if (p === null || p < 200 || p > 5000) {
      return invalid("pollMs must be an integer within [200, 5000].");
    }
  }
  return ok([]);
}

function clipboardGetArgs(args) {
  if (args.selection !== undefined && args.selection !== "clipboard" && args.selection !== "primary") {
    return invalid('selection must be "clipboard" or "primary".');
  }
  return ok([]);
}

function clipboardSetArgs(args) {
  const sel = clipboardGetArgs(args);
  if (!sel.ok) return sel;
  const text = typeof args.text === "string" ? args.text : null;
  if (text === null || text.length === 0 || text.length > MAX_CLIPBOARD_LEN) {
    return invalid(`text must be a non-empty string (max ${MAX_CLIPBOARD_LEN} chars).`);
  }
  return ok([]);
}

function focusWindowArgs(args) {
  const q = queryTextArgs(args, "title");
  if (!q.ok) return q;
  return ok([["-a", q.value]]);
}

/**
 * Validate a tool call. Returns `{ ok: true, cmds: string[][] }` where each
 * command is a full argv array for the tool's program (xdotool for input
 * tools), or `{ ok: false, error }` with the reason. `screenshot` and `wait`
 * produce no commands (the server handles them directly).
 */
export function parseToolArgs(tool, args) {
  const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  switch (tool) {
    case "screenshot":
      return ok([]);
    case "describe_screen":
      return ok([]);
    case "inspect_ui":
      return inspectUiArgs(input);
    case "click":
      return clickArgs(input, { double: false });
    case "double_click":
      return clickArgs(input, { double: true });
    case "click_text":
      return clickTextArgs(input);
    case "move":
      return moveArgs(input);
    case "drag":
      return dragArgs(input);
    case "type":
      return typeArgs(input);
    case "key":
      return keyArgs(input);
    case "scroll":
      return scrollArgs(input);
    case "open_app":
      return openAppArgs(input);
    case "focus_window":
      return focusWindowArgs(input);
    case "wait":
      return waitArgs(input);
    case "wait_for_text":
      return waitPollArgs(input, { requireText: true });
    case "wait_for_screen_change":
      return waitPollArgs(input, { requireText: false });
    case "clipboard_get":
      return clipboardGetArgs(input);
    case "clipboard_set":
      return clipboardSetArgs(input);
    default:
      return invalid(`unknown computer tool: ${tool}`);
  }
}

/** Short human-readable summary of a tool call (for telemetry / activity strip). */
export function summarizeTool(tool, args) {
  const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const s = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  switch (tool) {
    case "screenshot":
      return "Taking a screenshot";
    case "describe_screen":
      return "Reading screen layout and clickable text";
    case "inspect_ui": {
      const app = s(input.app);
      const query = s(input.query);
      const scope = [app && `in ${app.slice(0, 40)}`, query && `matching "${query.slice(0, 40)}"`].filter(Boolean).join(" ");
      return `Inspecting UI elements${scope ? ` ${scope}` : ""}`;
    }
    case "click": {
      const b = button(input.button);
      const label = b === 3 ? "right-clicking" : b === 2 ? "middle-clicking" : "clicking";
      return `${label[0].toUpperCase()}${label.slice(1)} at (${s(input.x)}, ${s(input.y)})`;
    }
    case "double_click":
      return `Double-clicking at (${s(input.x)}, ${s(input.y)})`;
    case "click_text":
      return `Clicking "${s(input.text).slice(0, 60)}"`;
    case "move":
      return `Moving pointer to (${s(input.x)}, ${s(input.y)})`;
    case "drag":
      return `Dragging from (${s(input.x1)}, ${s(input.y1)}) to (${s(input.x2)}, ${s(input.y2)})`;
    case "type": {
      // Length only, never content: typed text can carry credentials the
      // agent was given (a password from the prompt, a token to paste).
      // The host redacts known secret shapes before the event is built,
      // but the summary must not depend on redactor coverage — it is
      // rendered by the activity strip, the conversation timeline, run
      // reports, and the trajectory view.
      const text = s(input.text) || "";
      return `Typing (${text.length} chars)`;
    }
    case "key":
      return `Pressing ${s(input.combo) || "key"}`;
    case "scroll": {
      const dx = toInt(input.dx) ?? 0;
      const dy = toInt(input.dy) ?? 0;
      const parts = [];
      if (dy > 0) parts.push("down");
      if (dy < 0) parts.push("up");
      if (dx > 0) parts.push("right");
      if (dx < 0) parts.push("left");
      return `Scrolling ${parts.join(" and ") || ""}`.trim();
    }
    case "open_app": {
      const name = s(input.name);
      const label = Object.prototype.hasOwnProperty.call(OPEN_APPS, name) ? name : "app";
      return `Opening ${label}`;
    }
    case "focus_window":
      return `Focusing window "${s(input.title).slice(0, 60)}"`;
    case "wait":
      return `Waiting ${s(input.ms) || "0"}ms`;
    case "wait_for_text":
      return `Waiting for "${s(input.text).slice(0, 60)}"`;
    case "wait_for_screen_change":
      return "Waiting for screen change";
    case "clipboard_get":
      return "Reading clipboard";
    case "clipboard_set": {
      const len = typeof input.text === "string" ? input.text.length : 0;
      return `Setting clipboard (${len} chars)`;
    }
    default:
      return `Desktop action (${tool})`;
  }
}

/**
 * Parse `wmctrl -lG` stdout into window records with clickable center coords.
 * Enables non-vision LLMs to locate desktop windows without reading images.
 */
export function parseWmctrlWindows(stdout) {
  const rows = [];
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, id, , xStr, yStr, wStr, hStr, title] = m;
    const x = Number(xStr);
    const y = Number(yStr);
    const w = Number(wStr);
    const h = Number(hStr);
    rows.push({
      id,
      x,
      y,
      w,
      h,
      cx: Math.round(x + w / 2),
      cy: Math.round(y + h / 2),
      title: title.trim() || "(untitled)",
    });
  }
  return rows;
}

/**
 * Parse Tesseract TSV output into grouped line/word clickable bounding boxes.
 * Filters low-confidence noise and returns compact { text, cx, cy, x, y, w, h } targets.
 */
export function parseTesseractTsv(tsv, maxItems = 80) {
  const groups = new Map();
  const lines = String(tsv || "").split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < 12) continue;
    const level = Number(cols[0]);
    if (level !== 5) continue;
    const text = cols[11].trim();
    const conf = Number(cols[10]);
    if (!text || !Number.isFinite(conf) || conf < 35) continue;
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const lineKey = `${cols[1]}:${cols[2]}:${cols[3]}:${cols[4]}`;
    const existing = groups.get(lineKey);
    if (!existing) {
      groups.set(lineKey, {
        text,
        x1: left,
        y1: top,
        x2: left + width,
        y2: top + height,
      });
    } else {
      existing.text += ` ${text}`;
      existing.x1 = Math.min(existing.x1, left);
      existing.y1 = Math.min(existing.y1, top);
      existing.x2 = Math.max(existing.x2, left + width);
      existing.y2 = Math.max(existing.y2, top + height);
    }
  }
  const cap = Math.min(Math.max(Number(maxItems) || 80, 1), 150);
  const out = [];
  for (const g of groups.values()) {
    const w = g.x2 - g.x1;
    const h = g.y2 - g.y1;
    out.push({
      text: g.text.slice(0, 120),
      x: g.x1,
      y: g.y1,
      w,
      h,
      cx: Math.round(g.x1 + w / 2),
      cy: Math.round(g.y1 + h / 2),
    });
    if (out.length >= cap) break;
  }
  return out;
}

/** States surfaced for AT-SPI2 widgets (anything else from the helper is dropped). */
const UI_STATES = new Set([
  "focused",
  "focusable",
  "enabled",
  "checked",
  "pressed",
  "selected",
  "expanded",
  "editable",
  "modal",
  "active",
]);

/** Strip control characters and cap a label from the accessibility tree. */
function cleanLabel(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Parse the JSON printed by atspi_dump.py into widget records with clickable
 * center coordinates. Off-screen / zero-size / malformed nodes are dropped,
 * labels are sanitized, and coordinates are clamped to the screen cap.
 * Returns `{ ok, error?, apps, truncated, nodes }`; never throws.
 */
export function parseAtspiDump(stdout, maxItems = DEFAULT_UI_ITEMS) {
  const cap = Math.min(Math.max(Number(maxItems) || DEFAULT_UI_ITEMS, 1), MAX_UI_ITEMS);
  let data;
  try {
    const text = String(stdout || "").trim();
    const line = text.split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop() || "";
    data = JSON.parse(line);
  } catch {
    return { ok: false, error: "accessibility helper returned no JSON", apps: [], truncated: false, nodes: [] };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, error: "accessibility helper returned no JSON", apps: [], truncated: false, nodes: [] };
  }
  if (data.ok !== true) {
    return { ok: false, error: cleanLabel(data.error || "accessibility tree unavailable", 200), apps: [], truncated: false, nodes: [] };
  }
  const apps = Array.isArray(data.apps) ? data.apps.slice(0, 50).map((a) => cleanLabel(a, 60)).filter(Boolean) : [];
  const nodes = [];
  for (const raw of Array.isArray(data.nodes) ? data.nodes : []) {
    if (nodes.length >= cap) break;
    if (!raw || typeof raw !== "object") continue;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const w = Number(raw.w);
    const h = Number(raw.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const cx = Math.round(x + w / 2);
    const cy = Math.round(y + h / 2);
    // The center must be a coordinate click() accepts.
    if (cx < 0 || cy < 0 || cx > MAX_SCREEN_DIM || cy > MAX_SCREEN_DIM) continue;
    const role = cleanLabel(raw.role, 40).toLowerCase() || "unknown";
    const states = Array.isArray(raw.states)
      ? [...new Set(raw.states.map((st) => String(st)).filter((st) => UI_STATES.has(st)))]
      : [];
    nodes.push({
      app: cleanLabel(raw.app, 60),
      role,
      name: cleanLabel(raw.name, 120),
      states,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      cx,
      cy,
    });
  }
  return { ok: true, apps, truncated: data.truncated === true, nodes };
}

/**
 * Narrow parsed widgets by a case-insensitive name `query` and/or `role`
 * substring, then cap to `maxItems`.
 */
export function filterUiNodes(nodes, { query = "", role = "", maxItems = DEFAULT_UI_ITEMS } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const r = String(role || "").trim().toLowerCase();
  const cap = Math.min(Math.max(Number(maxItems) || DEFAULT_UI_ITEMS, 1), MAX_UI_ITEMS);
  const out = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (q && !node.name.toLowerCase().includes(q)) continue;
    if (r && !node.role.includes(r)) continue;
    out.push(node);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Render widgets as compact lines for a text-only model, e.g.
 *   [push button] "Save" (enabled, focused) -> click(812, 604) [780,592 64x24] @gedit
 * Disabled widgets are flagged so the model does not click them.
 */
export function formatUiNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .map((n) => {
      const flags = n.states.filter((st) => st !== "focusable" && st !== "enabled");
      if (!n.states.includes("enabled")) flags.unshift("disabled");
      const label = n.name ? ` "${n.name}"` : "";
      const st = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      const app = n.app ? ` @${n.app}` : "";
      return `  [${n.role}]${label}${st} -> click(${n.cx}, ${n.cy}) [${n.x},${n.y} ${n.w}x${n.h}]${app}`;
    })
    .join("\n");
}

/**
 * Find the best OCR target matching `query` (exact match preferred, then
 * case-insensitive substring match). Returns null when nothing matches.
 */
export function findTextTarget(targets, query, { exact = false } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle || !Array.isArray(targets)) return null;
  const exactHit = targets.find((t) => String(t?.text || "").trim().toLowerCase() === needle);
  if (exactHit) return exactHit;
  if (exact) return null;
  return targets.find((t) => String(t?.text || "").toLowerCase().includes(needle)) ?? null;
}
