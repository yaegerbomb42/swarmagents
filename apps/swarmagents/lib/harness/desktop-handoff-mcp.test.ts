/**
 * ask_human_desktop plumbing tests (lib/harness/desktop-handoff-mcp.ts).
 *
 * These pin the tool-name matcher, the bounded argument parser and the VM
 * paths/filenames of the file-based rendezvous. The seeded MCP server source
 * itself is exercised by the runtime integration test, not here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_HANDOFF_DIR,
  DESKTOP_HANDOFF_MCP_SERVER_NAME,
  DESKTOP_HANDOFF_MCP_SERVER_PATH,
  DESKTOP_HANDOFF_MCP_SERVER_SOURCE,
  DESKTOP_HANDOFF_TOOL,
  handoffPaths,
  isDesktopHandoffTool,
  parseDesktopHandoffArguments,
} from "./desktop-handoff-mcp";

test("handoff: recognizes the namespaced and bare tool names", () => {
  assert.equal(isDesktopHandoffTool(`mcp__${DESKTOP_HANDOFF_MCP_SERVER_NAME}__${DESKTOP_HANDOFF_TOOL}`), true);
  assert.equal(isDesktopHandoffTool("mcp__other__ask_human_desktop"), true);
  assert.equal(isDesktopHandoffTool("ask_human_desktop"), true);
  assert.equal(isDesktopHandoffTool("ask_human_desktop_extra"), false);
  assert.equal(isDesktopHandoffTool("Bash"), false);
  assert.equal(isDesktopHandoffTool("mcp__desktop-handoff__ask_user"), false);
  // The ask_user matcher must not claim this tool, and vice versa.
  assert.equal(String(isDesktopHandoffTool("mcp__ask__ask_user")), "false");
});

test("handoff: parses reason and optional description", () => {
  assert.deepEqual(parseDesktopHandoffArguments({ reason: "CAPTCHA" }), {
    reason: "CAPTCHA",
    description: "",
  });
  assert.deepEqual(
    parseDesktopHandoffArguments({ reason: "2FA", description: "Enter the code" }),
    { reason: "2FA", description: "Enter the code" },
  );
});

test("handoff: trims and bounds reason and description", () => {
  const parsed = parseDesktopHandoffArguments({
    reason: "  drag the slider to unlock  ",
    description: "d".repeat(9000),
  });
  assert.ok(parsed);
  assert.equal(parsed.reason, "drag the slider to unlock");
  assert.equal(parsed.description.length, 4000);
});

test("handoff: rejects missing or blank reasons", () => {
  assert.equal(parseDesktopHandoffArguments(undefined), null);
  assert.equal(parseDesktopHandoffArguments(null), null);
  assert.equal(parseDesktopHandoffArguments("reason"), null);
  assert.equal(parseDesktopHandoffArguments({}), null);
  assert.equal(parseDesktopHandoffArguments({ reason: "   " }), null);
  assert.equal(parseDesktopHandoffArguments({ reason: 42 }), null);
});

test("handoff: rendezvous paths stay inside the VM handoffs dir", () => {
  const paths = handoffPaths("h_123");
  assert.equal(paths.pending, `${DESKTOP_HANDOFF_DIR}/h_123.pending.json`);
  assert.equal(paths.answer, `${DESKTOP_HANDOFF_DIR}/h_123.answer.json`);
  assert.ok(paths.pending.startsWith("/workspace/"));
  assert.ok(paths.answer.startsWith("/workspace/"));
});

test("handoff: the seeded server is an MCP stdio server with an ask_human_desktop tool", () => {
  assert.equal(DESKTOP_HANDOFF_MCP_SERVER_PATH, "/workspace/.swarm/desktop-handoff-server.mjs");
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("#!/usr/bin/env node"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("tools/list"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("tools/call"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("ask_human_desktop"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("SWARM_DESKTOP_HANDOFF_DIR"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("handoff_expired"));
  // The server must never touch the host: it only reads/writes under its dir.
  assert.equal(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("/host/"), false);
  // The resolution surfaced to the agent never echoes a credential: the only
  // user-derived data returned is the compact state summary.
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("summary"));
});
