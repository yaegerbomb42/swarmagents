/**
 * Desktop computer-use tool surface for the harness.
 *
 * Two MCP servers give the agent control of the on-screen desktop (desktop
 * VM mode only, SWARM_VM_DESKTOP=1), and browser-mcp supplies the same real
 * Playwright surface through isolated headless Chromium in non-desktop VMs:
 *
 *   - `computer-mcp`   — the shipped desktop MCP server (screenshot/click/
 *     type/key/scroll/open_app/...), implemented with xdotool/scrot.
 *   - `playwright-mcp` — the pinned @playwright/mcp server driving the same
 *     visible Chromium on DISPLAY=:1.
 *
 * This module knows how to recognize their tool-call names in the claude
 * stream (`mcp__<server>__<tool>`), classify each call with the harness risk
 * gate (see ./risk.ts), and synthesize the short human-readable summary that
 * the `computer.action` telemetry event carries to the activity strip.
 *
 * Argument validation for computer-mcp tools lives in the shared validator
 * `vm-image-desktop/computer-mcp/validate.mjs` — the exact module the server
 * itself executes — so the risk gate and the server always agree.
 */

import { parseToolArgs, summarizeTool } from "../../vm-image-desktop/computer-mcp/validate.mjs";
import { checkNavigation, checkNavigationAsync, isLoopbackHost, parseNavigationUrl, lookupAddresses } from "../browser/policy";
import { isUserDriving } from "../runtime/user-driving";
import type { RiskDecision } from "./risk";
import type { TelemetryEvent } from "./types";

/** The desktop computer-use MCP server id (role MCP registry). */
export const COMPUTER_MCP_SERVER = "computer-mcp";
/** The desktop browser MCP server id (role MCP registry). */
export const PLAYWRIGHT_MCP_SERVER = "playwright-mcp";
/** The headless browser MCP server id (same tools, isolated in-VM Chromium). */
export const BROWSER_MCP_SERVER = "browser-mcp";

/** Both desktop MCP server ids, in the order they are wired into a run. */
export const DESKTOP_MCP_SERVERS: readonly string[] = [COMPUTER_MCP_SERVER, PLAYWRIGHT_MCP_SERVER];

/** Does a tool-call name point at a desktop or headless computer-use server? */
export function isDesktopMcpCall(name: string): boolean {
  const info = parseMcpToolName(name);
  return info !== null && (DESKTOP_MCP_SERVERS.includes(info.server) || info.server === BROWSER_MCP_SERVER);
}

/** The server + tool a (possibly `mcp__server__tool`-prefixed) call names. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (typeof name !== "string" || !name) return null;
  const parts = name.split("__");
  const tool = parts[parts.length - 1];
  const server = parts.length >= 2 ? parts[parts.length - 2] : "";
  if (!tool || !server) return null;
  return { server, tool };
}

/** The desktop MCP tool id for a matching call name, or null. */
export function desktopMcpTool(name: string): string | null {
  const info = parseMcpToolName(name);
  if (!info || !DESKTOP_MCP_SERVERS.includes(info.server)) return null;
  return info.tool;
}

/** Playwright MCP tools that navigate to a URL (target field for telemetry). */
const PLAYWRIGHT_NAV_TOOLS = new Set(["browser_navigate"]);

/**
 * Playwright MCP tools that return a raw screenshot image. The current
 * @playwright/mcp name is `browser_take_screenshot`; `browser_screen_capture`
 * is the vision-mode capture tool, and `browser_screenshot` covers older
 * builds and the browser-mcp alias.
 */
const PLAYWRIGHT_SCREENSHOT_TOOLS = new Set([
  "browser_take_screenshot",
  "browser_screen_capture",
  "browser_screenshot",
]);

/**
 * Deny reason for a raw screenshot call in text-desktop mode, telling the
 * model which text inspection tool to use instead. The computer-mcp server
 * itself maps `screenshot` to describe_screen text when SWARM_TEXT_DESKTOP=1,
 * so this is the hook-path enforcement; the server mapping covers runs
 * without the hook.
 */
function textDesktopScreenshotReason(server: string): string {
  if (server === COMPUTER_MCP_SERVER) {
    return (
      "screenshots are disabled in text-desktop mode (this model has no vision); " +
      "call describe_screen instead — it returns window bounds and OCR text coordinates"
    );
  }
  return (
    "screenshots are disabled in text-desktop mode (this model has no vision); " +
    "call browser_snapshot instead — it returns the page's accessibility tree as text"
  );
}

/** True when a tool-call name is a raw screenshot call (image bytes out). */
export function isRawScreenshotCall(name: string): boolean {
  const info = parseMcpToolName(name);
  if (!info) return false;
  if (info.server === COMPUTER_MCP_SERVER) return info.tool === "screenshot";
  if (info.server === PLAYWRIGHT_MCP_SERVER || info.server === BROWSER_MCP_SERVER) {
    return PLAYWRIGHT_SCREENSHOT_TOOLS.has(info.tool);
  }
  return false;
}

/**
 * Short display text for a playwright interaction target: the human-readable
 * `element` description when given, else the selector/ref, capped so a giant
 * snapshot cannot spill into a telemetry summary.
 */
function playwrightTarget(args: Record<string, unknown>): string {
  const element = typeof args.element === "string" ? args.element.trim() : "";
  if (element) return element.slice(0, 80);
  const target = typeof args.target === "string" ? args.target.trim() : "";
  if (target) return target.slice(0, 80);
  return "";
}

/**
 * Classify a desktop (computer-mcp / playwright-mcp) tool call.
 *
 * - computer-mcp tools: the shared validator decides; invalid arguments are
 *   denied (the server would reject them anyway, but the gate should never
 *   let a malformed call through), everything else is allowed.
 * - Playwright tools: explicit loopback HTTP(S) URLs are allowed for dev
 *   servers inside the VM; other private/reserved destinations are denied.
 *   Public destinations go through the same checks in both modes. See
 *   `classifyDesktopToolCallAsync` for the DNS-aware variant.
 * - Text-desktop mode (`opts.textDesktop`): raw screenshot calls are denied
 *   — a model without vision cannot use image bytes, and the deny reason
 *   points it at describe_screen / the accessibility snapshots instead.
 *   Only pass `textDesktop` from a pre-execution gate (the approval hook):
 *   the runner's post-hoc re-checks call this without it, so a call the
 *   server already answered as text never halts the run.
 */
const READ_ONLY_COMPUTER_TOOLS = new Set(["screenshot", "describe_screen", "inspect_ui"]);
const USER_DRIVING_DENY_REASON = "the user is controlling the desktop; wait or call describe_screen";

export interface ClassifyDesktopOptions {
  textDesktop?: boolean;
  userDriving?: boolean;
  runId?: string;
}

function isUserControllingDesktop(info: { server: string; tool: string }, opts: ClassifyDesktopOptions): boolean {
  if (info.server !== COMPUTER_MCP_SERVER || READ_ONLY_COMPUTER_TOOLS.has(info.tool)) return false;
  return opts.userDriving === true || (typeof opts.runId === "string" && isUserDriving(opts.runId));
}

export function classifyDesktopToolCall(
  name: string,
  input: unknown,
  opts: ClassifyDesktopOptions = {},
): RiskDecision | null {
  const info = parseMcpToolName(name);
  if (!info) return null;
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

  if (opts.textDesktop && isRawScreenshotCall(name)) {
    return { level: "deny", reason: textDesktopScreenshotReason(info.server) };
  }
  if (isUserControllingDesktop(info, opts)) {
    return { level: "deny", reason: USER_DRIVING_DENY_REASON };
  }

  if (info.server === COMPUTER_MCP_SERVER) {
    const parsed = parseToolArgs(info.tool, args);
    if (!parsed.ok) {
      return { level: "deny", reason: `invalid desktop action: ${parsed.error}` };
    }
    return { level: "allow", reason: "desktop input action" };
  }

  if (info.server === PLAYWRIGHT_MCP_SERVER || info.server === BROWSER_MCP_SERVER) {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (PLAYWRIGHT_NAV_TOOLS.has(info.tool)) {
      if (!url) return { level: "allow", reason: "browser action" };
      const parsed = parseNavigationUrl(url);
      const localPreview = parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname);
      if (!localPreview && !checkNavigation(url).ok) {
        return { level: "deny", reason: "browser navigation to private or non-loopback local destinations is not allowed" };
      }
    }
    return { level: "allow", reason: "browser action" };
  }

  return null;
}

/**
 * DNS-aware classification the harness runs before it lets a browser
 * navigation proceed. The synchronous `classifyDesktopToolCall` catches
 * scheme, address-literal, and reserved-hostname violations; this runs the
 * same shared DNS preflight as BrowserManager (`checkNavigationAsync`) so a
 * hostname that resolves into private/loopback/metadata space is denied even
 * when its spelling looks public. `lookup` is injectable for tests.
 */
export async function classifyDesktopToolCallAsync(
  name: string,
  input: unknown,
  lookup: (host: string) => Promise<string[]> = lookupAddresses,
  opts: ClassifyDesktopOptions = {},
): Promise<RiskDecision | null> {
  const info = parseMcpToolName(name);
  if (!info) return null;
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

  if (opts.textDesktop && isRawScreenshotCall(name)) {
    return { level: "deny", reason: textDesktopScreenshotReason(info.server) };
  }
  if (isUserControllingDesktop(info, opts)) {
    return { level: "deny", reason: USER_DRIVING_DENY_REASON };
  }

  if (info.server === COMPUTER_MCP_SERVER) {
    const parsed = parseToolArgs(info.tool, args);
    if (!parsed.ok) {
      return { level: "deny", reason: `invalid desktop action: ${parsed.error}` };
    }
    return { level: "allow", reason: "desktop input action" };
  }

  if (info.server === PLAYWRIGHT_MCP_SERVER || info.server === BROWSER_MCP_SERVER) {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (PLAYWRIGHT_NAV_TOOLS.has(info.tool)) {
      if (!url) return { level: "allow", reason: "browser action" };
      const parsed = parseNavigationUrl(url);
      const localPreview = parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname);
      const check = localPreview ? { ok: true as const, url: parsed!.toString() } : await checkNavigationAsync(url, lookup);
      if (!check.ok) {
        return { level: "deny", reason: `browser navigation to private or non-loopback local destinations is not allowed (${check.reason})` };
      }
    }
    return { level: "allow", reason: "browser action" };
  }

  return null;
}

/** Short human-readable summary of a desktop tool call (redacted by caller). */
export function describeDesktopAction(name: string, input: unknown): string {
  const info = parseMcpToolName(name);
  if (!info) return `Desktop action (${name})`;
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

  if (info.server === COMPUTER_MCP_SERVER) {
    return summarizeTool(info.tool, args);
  }

  // Playwright MCP: reuse the tool's own arguments for a short synopsis.
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (PLAYWRIGHT_NAV_TOOLS.has(info.tool)) {
    if (url) {
      const host = parseNavigationUrl(url)?.hostname ?? url;
      return `Opening ${host}`;
    }
    return "Opening a new tab";
  }
  if (info.tool === "browser_snapshot" || info.tool === "browser_accessible_snapshot") {
    return "Reading the page";
  }
  const target = playwrightTarget(args);
  if (info.tool === "browser_click") {
    return target ? `Clicking ${target}` : "Clicking on the page";
  }
  if (info.tool === "browser_type") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return target ? `Typing into ${target}` : "Typing into the page";
    // Length only, never content — see summarizeTool's type case in
    // validate.mjs. Typed text can carry credentials the agent was
    // given; the summary is rendered on several surfaces and must not
    // depend on redactor coverage.
    return `Typing (${text.length} chars)`;
  }
  if (info.tool === "browser_press_key") {
    const key = typeof args.key === "string" ? args.key : "";
    return key ? `Pressing ${key}` : "Pressing a key";
  }
  if (info.tool === "browser_mouse_wheel") {
    return "Scrolling the page";
  }
  if (info.tool === "browser_hover") {
    return target ? `Hovering ${target}` : "Moving the pointer";
  }
  const toolLabel = info.tool.replace(/^browser_/, "").replace(/_/g, " ");
  return `${toolLabel[0]?.toUpperCase() ?? ""}${toolLabel.slice(1)}`.trim() || "Browser action";
}

/**
 * Build the `computer.action` telemetry event for a desktop tool call.
 *
 * `input` must already be redacted (the runner deep-redacts tool input before
 * calling this) so no secret — whole or truncated — can reach the summary or
 * the structured fields. The summary is the short human-readable synopsis the
 * activity strip renders; the optional fields carry the structured target.
 */
export function computerActionEvent(
  name: string,
  input: unknown,
): Extract<TelemetryEvent, { type: "computer.action" }> {
  const info = parseMcpToolName(name);
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  const event: Extract<TelemetryEvent, { type: "computer.action" }> = {
    type: "computer.action",
    action: describeDesktopAction(name, input),
  };
  if (!info) return event;

  if (info.server === COMPUTER_MCP_SERVER) {
    const x = n(obj.x) ?? n(obj.x1);
    const y = n(obj.y) ?? n(obj.y1);
    if (x !== undefined) event.x = x;
    if (y !== undefined) event.y = y;
    const text = s(obj.text);
    // Never attach clipboard_set text to telemetry (may contain credentials);
    // for click_text/wait_for_text it is a UI query target, not secret input.
    if (text !== undefined && info.tool !== "clipboard_set") {
      if (info.tool === "click_text" || info.tool === "wait_for_text") {
        event.target = text.slice(0, 80);
      } else {
        event.text = text;
      }
    }
    const combo = s(obj.combo);
    if (combo !== undefined) event.text = combo;
    const app = s(obj.name) ?? s(obj.title);
    if (app !== undefined) event.target = app.slice(0, 80);
    return event;
  }

  // Playwright MCP: navigations carry the URL; interactions carry the
  // element description/ref as the target.
  const url = s(obj.url)?.trim();
  if (url) event.url = url;
  const target = typeof obj.element === "string" ? obj.element.trim() : typeof obj.target === "string" ? obj.target.trim() : "";
  if (target) event.target = target;
  const text = s(obj.text)?.trim() ?? s(obj.value);
  if (text !== undefined) event.text = text;
  const key = s(obj.key);
  if (key !== undefined) event.text = key;
  return event;
}
