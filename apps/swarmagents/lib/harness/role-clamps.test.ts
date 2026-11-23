/**
 * Unit tests for lib/harness/role-clamps.ts.
 *
 * Ported from the vendored engine's filter/bind tests, plus coverage for the
 * RunRequest adapter (`applyRoleToRunRequest`) that is specific to this app.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRoleToLoopDeps,
  applyRoleToRunRequest,
  assertToolAllowed,
  clampedDeadlineMs,
  clampedMaxTokens,
  clampedTurnCeiling,
  clampedTurnTimeoutMs,
  filteredTools,
  isToolAllowed,
  normalizeToolName,
  roleDeadlineMs,
  roleMaxTurns,
  roleModelRoute,
  roleSystemPrompt,
  RoleToolDeniedError,
  toolDenialMessage,
  toolDenialReason,
  type RoleClamp,
  type RoleLoopSlice,
} from "./role-clamps";
import type { RolePhase, RunRequest } from "./types";

function makeTool(name: string): { name: string } {
  return { name };
}

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    prompt: "hi",
    env: {},
    vm: { exec: async () => ({ exitCode: 0 }) },
    ...overrides,
  };
}

function makePhase(allowedTools: string[]): RolePhase {
  return { roleId: "r", roleName: "R", allowedTools, mcpConfigPath: "/tmp/mcp.json" };
}

test("roleMaxTurns / roleDeadlineMs prefer modelConfig over the shorthand", () => {
  expectRoleMaxTurns();
});

function expectRoleMaxTurns(): void {
  const role: RoleClamp = {
    id: "r",
    name: "R",
    maxTurns: 8,
    maxDeadlineMs: 500,
    modelConfig: { maxTurns: 3, deadlineMs: 100 },
  };
  assert.equal(roleMaxTurns(role), 3);
  assert.equal(roleDeadlineMs(role), 100);
  assert.equal(roleMaxTurns({ id: "r", maxTurns: 8 }), 8);
  assert.equal(roleMaxTurns(undefined), undefined);
}

test("clampedTurnCeiling clamps, honors modelConfig, and floors at 1", () => {
  assert.equal(clampedTurnCeiling({ id: "r", maxTurns: 8 }, 20), 8);
  assert.equal(
    clampedTurnCeiling({ id: "r", maxTurns: 8, modelConfig: { maxTurns: 3 } }, 20),
    3,
  );
  // No role → the (floored) global value.
  assert.equal(clampedTurnCeiling(undefined, 20), 20);
  assert.equal(clampedTurnCeiling(undefined, 0), 1);
  assert.equal(clampedTurnCeiling(undefined, NaN), 1);
  assert.equal(clampedTurnCeiling(undefined, -10), 1);
  // Role above the global → the global wins.
  assert.equal(clampedTurnCeiling({ id: "r", maxTurns: 50 }, 20), 20);
  // Role below 1 still clamps to at least 1.
  assert.equal(clampedTurnCeiling({ id: "r", maxTurns: 0 }, 20), 1);
  assert.equal(clampedTurnCeiling({ id: "r", maxTurns: -5 }, 20), 1);
  assert.equal(clampedTurnCeiling({ id: "r", maxTurns: NaN }, 20), 20);
  assert.equal(clampedTurnCeiling({ id: "r", maxTurns: 8.7 }, 20), 8);
});

test("clampedDeadlineMs combines role and global deadlines", () => {
  // Role deadline when global is later.
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 300_000 }, 1_000_000, 0), 300_000);
  // Global when the role is later.
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 900_000 }, 600_000, 0), 600_000);
  // Role deadline without a global.
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 120_000 }, undefined, 0), 120_000);
  // Neither → undefined.
  assert.equal(clampedDeadlineMs(undefined, undefined, 0), undefined);
  // Relative deadline is measured from cycleStartMs.
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 120_000 }, undefined, 1_000), 121_000);
});

test("clampedDeadlineMs ignores NaN, infinite, and non-positive inputs", () => {
  // A bad role deadline is ignored, never NaN / infinite / already-past.
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: NaN }, undefined, 0), undefined);
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: Infinity }, undefined, 0), undefined);
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 0 }, undefined, 1_000), undefined);
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: -100 }, undefined, 1_000), undefined);
  // With a valid global the role value is dropped and the global wins.
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: NaN }, 600_000, 0), 600_000);
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: Infinity }, 600_000, 0), 600_000);
  // A bad global is ignored the same way, leaving the role deadline.
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 120_000 }, NaN, 1_000), 121_000);
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 120_000 }, Infinity, 1_000), 121_000);
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 120_000 }, 0, 1_000), 121_000);
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 120_000 }, -5, 1_000), 121_000);
  // Both bad → undefined, never NaN.
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: NaN }, NaN, 0), undefined);
  assert.equal(clampedDeadlineMs(undefined, NaN, 0), undefined);
  // A non-finite cycle start is treated as 0 rather than poisoning the sum.
  assert.equal(clampedDeadlineMs({ id: "r", maxDeadlineMs: 120_000 }, undefined, NaN), 120_000);
});

test("normalizeToolName unifies snake_case, PascalCase, and odd casings", () => {
  assert.equal(normalizeToolName("write_file"), "write");
  assert.equal(normalizeToolName("Write"), "write");
  assert.equal(normalizeToolName("WRITE"), "write");
  assert.equal(normalizeToolName("write-file"), "write");
  assert.equal(normalizeToolName("edit_file"), "edit");
  assert.equal(normalizeToolName("Edit"), "edit");
  assert.equal(normalizeToolName("multi_edit"), "multiedit");
  assert.equal(normalizeToolName("MultiEdit"), "multiedit");
  assert.equal(normalizeToolName("MULTIEDIT"), "multiedit");
  assert.equal(normalizeToolName("NotebookEdit"), "notebookedit");
  assert.equal(normalizeToolName("notebook_edit"), "notebookedit");
  assert.equal(normalizeToolName("restore_checkpoint"), "checkpoint");
  assert.equal(normalizeToolName("Checkpoint"), "checkpoint");
  assert.equal(normalizeToolName("Bash"), "bash");
  assert.equal(normalizeToolName("BASH"), "bash");
  assert.equal(normalizeToolName("web_fetch"), "webfetch");
  assert.equal(normalizeToolName("WebFetch"), "webfetch");
  assert.equal(normalizeToolName("api_request"), "apirequest");
  assert.equal(normalizeToolName("ApiRequest"), "apirequest");
  assert.equal(normalizeToolName("str_replace"), "strreplace");
  assert.equal(normalizeToolName("StrReplace"), "strreplace");
  // Unknown names pass through unchanged (lowercased, separators stripped).
  assert.equal(normalizeToolName("read"), "read");
  assert.equal(normalizeToolName("Read"), "read");
});

test("permission flags deny every casing and alias of a guarded tool", () => {
  const locked: RoleClamp = {
    id: "locked",
    permissions: { readOnly: true, networkAllowed: false, commandExecutionAllowed: false },
  };
  // File mutations denied by readOnly, however they are spelled.
  for (const tool of [
    "write_file",
    "Write",
    "WRITE",
    "write",
    "write-file",
    "edit_file",
    "Edit",
    "EDIT",
    "edit",
    "multi_edit",
    "MultiEdit",
    "MULTIEDIT",
    "NotebookEdit",
    "notebook_edit",
    "str_replace",
    "StrReplace",
    "replace_lines",
    "restore_checkpoint",
    "Checkpoint",
  ]) {
    assert.equal(isToolAllowed(locked, tool), false, `${tool} must be denied under readOnly`);
    assert.match(toolDenialReason(locked, tool) ?? "", /read-only/);
  }

  // Command execution denied however it is spelled.
  for (const tool of ["bash", "Bash", "BASH"]) {
    assert.equal(isToolAllowed(locked, tool), false, `${tool} must be denied under commandExecutionAllowed: false`);
    assert.match(toolDenialReason(locked, tool) ?? "", /execute commands/);
  }

  // Network tools denied however they are spelled, including MCP servers.
  for (const tool of [
    "web_fetch",
    "WebFetch",
    "webfetch",
    "Webfetch",
    "web_search",
    "WebSearch",
    "Browser",
    "browser",
    "BROWSER",
    "ApiRequest",
    "api_request",
    "mcp__github-mcp__get_issue",
    "mcp__browser-mcp__navigate",
    "mcp__playwright-mcp__browser_navigate",
    "MCP__github-mcp__get_issue",
  ]) {
    assert.equal(isToolAllowed(locked, tool), false, `${tool} must be denied under networkAllowed: false`);
    assert.match(toolDenialReason(locked, tool) ?? "", /network/);
  }

  // Read-only tools stay allowed under the same role.
  for (const tool of ["read", "Read", "read_file", "search", "Grep", "Glob", "plan"]) {
    assert.equal(isToolAllowed(locked, tool), true, `${tool} must stay allowed`);
  }
});

test("the whitelist stays an exact match even though permissions normalize", () => {
  // A whitelist entry for the engine name does not admit the Claude Code
  // spelling (and vice versa): the whitelist is fail-closed, only the
  // permission sets normalize.
  const role: RoleClamp = { id: "r", allowedTools: ["write_file"] };
  assert.equal(isToolAllowed(role, "write_file"), true);
  assert.equal(isToolAllowed(role, "Write"), false);
  assert.match(toolDenialReason(role, "Write") ?? "", /whitelist/);
});

test("filteredTools keeps only allowed tools (whitelist and permissions)", () => {
  const tools = [
    makeTool("read"),
    makeTool("bash"),
    makeTool("write_file"),
    makeTool("Bash"),
    makeTool("Write"),
    makeTool("WebSearch"),
  ];
  const role: RoleClamp = { id: "r", name: "R", allowedTools: ["read", "bash", "Write"] };
  assert.deepEqual(
    filteredTools(role, tools).map((t) => t.name),
    ["read", "bash", "Write"],
  );

  // Permission flags filter even without allowedTools set:
  const readOnlyRole: RoleClamp = {
    id: "reader",
    permissions: { readOnly: true, commandExecutionAllowed: false, networkAllowed: false },
  };
  assert.deepEqual(
    filteredTools(readOnlyRole, tools).map((t) => t.name),
    ["read"],
  );

  // No role → all tools, unchanged.
  assert.deepEqual(filteredTools(undefined, tools), tools);
});

test("isToolAllowed / toolDenialReason enforce whitelist and permissions for engine and Claude Code names", () => {
  const role: RoleClamp = { id: "r", name: "R", allowedTools: ["read"] };
  assert.equal(isToolAllowed(role, "read"), true);
  assert.equal(isToolAllowed(role, "bash"), false);
  assert.match(toolDenialReason(role, "bash") ?? "", /whitelist/);
  assert.match(toolDenialMessage(role, "bash") ?? "", /^Role tool denial: /);
  assert.throws(() => assertToolAllowed(role, "bash"), RoleToolDeniedError);

  // No role → everything allowed.
  assert.equal(isToolAllowed(undefined, "anything"), true);
  assert.equal(toolDenialReason(undefined, "anything"), undefined);

  // Permission flags deny both engine and Claude Code / permission names.
  const locked: RoleClamp = {
    id: "locked",
    name: "Locked",
    allowedTools: [
      "read",
      "write_file",
      "edit_file",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "bash",
      "Bash",
      "web_search",
      "WebSearch",
      "WebFetch",
      "Browser",
      "ApiRequest",
      "mcp__github-mcp__*",
    ],
    permissions: { readOnly: true, networkAllowed: false, commandExecutionAllowed: false },
  };
  assert.equal(isToolAllowed(locked, "read"), true);

  // File mutations denied by readOnly
  for (const tool of ["write_file", "edit_file", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.equal(isToolAllowed(locked, tool), false, `${tool} must be denied under readOnly`);
    assert.match(toolDenialReason(locked, tool) ?? "", /read-only/);
  }

  // Command executions denied by commandExecutionAllowed: false
  for (const tool of ["bash", "Bash"]) {
    assert.equal(isToolAllowed(locked, tool), false, `${tool} must be denied under commandExecutionAllowed: false`);
    assert.match(toolDenialReason(locked, tool) ?? "", /execute commands/);
  }

  // Network reached tools denied by networkAllowed: false
  for (const tool of ["web_search", "WebSearch", "WebFetch", "Browser", "ApiRequest", "mcp__github-mcp__*"]) {
    assert.equal(isToolAllowed(locked, tool), false, `${tool} must be denied under networkAllowed: false`);
    assert.match(toolDenialReason(locked, tool) ?? "", /network/);
  }
});

test("clampedMaxTokens and clampedTurnTimeoutMs guard non-finite and <= 0 numbers", () => {
  const role: RoleClamp = { id: "r", modelConfig: { maxTokens: 4096, turnTimeoutMs: 5_000 } };
  assert.equal(clampedMaxTokens(role, 8192), 4096);
  assert.equal(clampedMaxTokens(role, undefined), 4096);
  assert.equal(clampedMaxTokens(undefined, 8192), 8192);
  assert.equal(clampedMaxTokens(undefined, undefined), undefined);
  assert.equal(clampedMaxTokens({ id: "r", modelConfig: { maxTokens: NaN } }, 8192), 8192);
  assert.equal(clampedMaxTokens({ id: "r", modelConfig: { maxTokens: -50 } }, 8192), 8192);

  assert.equal(clampedTurnTimeoutMs(role, 30_000), 5_000);
  assert.equal(clampedTurnTimeoutMs({ id: "r", modelConfig: { turnTimeoutMs: 5_000 } }, undefined), 5_000);
  assert.equal(clampedTurnTimeoutMs(undefined, 30_000), 30_000);
  assert.equal(clampedTurnTimeoutMs(undefined, undefined), undefined);
  assert.equal(clampedTurnTimeoutMs({ id: "r", modelConfig: { turnTimeoutMs: -100 } }, 30_000), 30_000);
  assert.equal(clampedTurnTimeoutMs({ id: "r", modelConfig: { turnTimeoutMs: NaN } }, 30_000), 30_000);
});

test("roleSystemPrompt and roleModelRoute", () => {
  assert.equal(roleSystemPrompt({ id: "r", systemPrompt: "Be careful." }), "Be careful.");
  assert.equal(roleSystemPrompt(undefined), undefined);

  const route = roleModelRoute({
    id: "r",
    modelConfig: { provider: "anthropic", modelId: "claude-sonnet", temperature: 0.1, maxTokens: 100 },
  });
  assert.deepEqual(route, {
    provider: "anthropic",
    modelId: "claude-sonnet",
    temperature: 0.1,
    maxTokens: 100,
  });
  assert.throws(() => roleModelRoute({ id: "x" }), /modelConfig/);
});

test("applyRoleToLoopDeps clamps and filters, and is a no-op without a role", () => {
  const tools = [makeTool("read"), makeTool("bash"), makeTool("write_file")];
  const role: RoleClamp = {
    id: "r",
    name: "R",
    maxTurns: 4,
    maxDeadlineMs: 1_000,
    modelConfig: { maxTokens: 2_000 },
    allowedTools: ["read"],
  };
  const deps: RoleLoopSlice = {
    role,
    budget: { max_turns_per_cycle: 100 },
    maxTokens: 100_000,
    deadlineMs: 10_000_000,
    tools,
    clock: { now: () => 0 },
  };
  const applied = applyRoleToLoopDeps(deps);
  assert.equal(applied.budget.max_turns_per_cycle, 4);
  assert.equal(applied.maxTokens, 2_000);
  assert.equal(applied.deadlineMs, 1_000);
  assert.deepEqual(applied.tools.map((t) => t.name), ["read"]);

  const bare = {
    budget: { max_turns_per_cycle: 9 },
    maxTokens: 100,
    tools: [makeTool("bash")],
    clock: { now: () => 1 },
  };
  assert.equal(applyRoleToLoopDeps(bare), bare);
});

test("applyRoleToRunRequest returns the request unchanged when there is no role", () => {
  const req = makeRequest({ rolePhase: makePhase(["read", "bash"]) });
  const applied = applyRoleToRunRequest(req, undefined, { globalMaxTurns: 50 });
  assert.equal(applied.request, req);
  assert.deepEqual(applied.limits, {});
  assert.deepEqual(applied.denials, []);
  assert.equal(applied.changed, false);
});

test("applyRoleToRunRequest narrows tools, reports denials, and resolves limits", () => {
  const req = makeRequest({ rolePhase: makePhase(["read", "bash", "write_file"]) });
  const role: RoleClamp = {
    id: "coder",
    allowedTools: ["read", "write_file"],
    maxTurns: 6,
    maxDeadlineMs: 60_000,
    modelConfig: { maxTokens: 4_096, turnTimeoutMs: 5_000 },
  };
  const applied = applyRoleToRunRequest(req, role, {
    globalMaxTurns: 100,
    globalMaxTokens: 100_000,
    globalTurnTimeoutMs: 30_000,
    cycleStartMs: 1_000,
  });

  // Tool whitelist applied to the request's rolePhase.
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.request.rolePhase?.allowedTools, ["read", "write_file"]);
  // Original request is not mutated.
  assert.deepEqual(req.rolePhase?.allowedTools, ["read", "bash", "write_file"]);

  // Clamps resolved against the globals.
  assert.deepEqual(applied.limits, {
    maxTurns: 6,
    deadlineMs: 61_000,
    maxTokens: 4_096,
    turnTimeoutMs: 5_000,
  });

  // The removed tool is reported with a reason.
  assert.equal(applied.denials.length, 1);
  assert.equal(applied.denials[0].tool, "bash");
  assert.match(applied.denials[0].reason, /whitelist/);
});

test("applyRoleToRunRequest strips permission-denied tools even without allowedTools", () => {
  const req = makeRequest({
    rolePhase: makePhase(["Read", "Write", "Bash", "WebFetch", "mcp__github-mcp__*"]),
  });
  const role: RoleClamp = {
    id: "reviewer",
    permissions: { readOnly: true, commandExecutionAllowed: false, networkAllowed: false },
  };
  const applied = applyRoleToRunRequest(req, role);

  assert.equal(applied.changed, true);
  assert.deepEqual(applied.request.rolePhase?.allowedTools, ["Read"]);
  assert.equal(applied.denials.length, 4);
});

test("applyRoleToRunRequest strips oddly-cased and aliased tools from the phase", () => {
  const req = makeRequest({
    rolePhase: makePhase(["Read", "write", "WRITE", "BASH", "webfetch", "MCP__github-mcp__x"]),
  });
  const role: RoleClamp = {
    id: "reviewer",
    permissions: { readOnly: true, commandExecutionAllowed: false, networkAllowed: false },
  };
  const applied = applyRoleToRunRequest(req, role);

  assert.equal(applied.changed, true);
  assert.deepEqual(applied.request.rolePhase?.allowedTools, ["Read"]);
  assert.equal(applied.denials.length, 5);
  assert.deepEqual(
    applied.denials.map((d) => d.tool),
    ["write", "WRITE", "BASH", "webfetch", "MCP__github-mcp__x"],
  );
});

test("applyRoleToRunRequest populates limits when defined by role even without opts", () => {
  const req = makeRequest({ rolePhase: makePhase(["read"]) });
  const role: RoleClamp = {
    id: "bounded",
    maxTurns: 12,
    modelConfig: { maxTokens: 2048, turnTimeoutMs: 10000, deadlineMs: 50000 },
  };
  const applied = applyRoleToRunRequest(req, role);

  assert.deepEqual(applied.limits, {
    maxTurns: 12,
    maxTokens: 2048,
    turnTimeoutMs: 10000,
    deadlineMs: 50000,
  });
});

test("applyRoleToRunRequest keeps the request unchanged when all tools are allowed", () => {
  const req = makeRequest({ rolePhase: makePhase(["read", "bash"]) });
  const role: RoleClamp = { id: "r", allowedTools: ["read", "bash"] };
  const applied = applyRoleToRunRequest(req, role, {});
  assert.equal(applied.changed, false);
  assert.equal(applied.request, req);
  assert.deepEqual(applied.denials, []);
});

test("applyRoleToRunRequest omits limits with no global and no role value", () => {
  const req = makeRequest({ rolePhase: makePhase(["read"]) });
  const applied = applyRoleToRunRequest(req, { id: "r", allowedTools: ["read"] }, {});
  assert.deepEqual(applied.limits, {});
});
