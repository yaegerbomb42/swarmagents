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
  // Role above the global → the global wins.
  assert.equal(clampedTurnCeiling({ id: "r", maxTurns: 50 }, 20), 20);
  // Role below 1 still clamps to at least 1.
  assert.equal(clampedTurnCeiling({ id: "r", maxTurns: 0 }, 20), 1);
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

test("filteredTools keeps only whitelisted tools", () => {
  const tools = [makeTool("read"), makeTool("bash"), makeTool("write_file")];
  const role: RoleClamp = { id: "r", name: "R", allowedTools: ["read", "bash"] };
  assert.deepEqual(
    filteredTools(role, tools).map((t) => t.name),
    ["read", "bash"],
  );
  // No whitelist → all tools, unchanged.
  assert.deepEqual(filteredTools(undefined, tools), tools);
  assert.deepEqual(filteredTools({ id: "r", name: "R" }, tools), tools);
});

test("isToolAllowed / toolDenialReason enforce whitelist and permissions", () => {
  const role: RoleClamp = { id: "r", name: "R", allowedTools: ["read"] };
  assert.equal(isToolAllowed(role, "read"), true);
  assert.equal(isToolAllowed(role, "bash"), false);
  assert.match(toolDenialReason(role, "bash") ?? "", /whitelist/);
  assert.match(toolDenialMessage(role, "bash") ?? "", /^Role tool denial: /);
  assert.throws(() => assertToolAllowed(role, "bash"), RoleToolDeniedError);

  // No role → everything allowed.
  assert.equal(isToolAllowed(undefined, "anything"), true);
  assert.equal(toolDenialReason(undefined, "anything"), undefined);

  // Permission flags deny even if the tool is mistakenly whitelisted.
  const locked: RoleClamp = {
    id: "locked",
    name: "Locked",
    allowedTools: ["read", "write_file", "bash", "web_search"],
    permissions: { readOnly: true, networkAllowed: false, commandExecutionAllowed: false },
  };
  assert.equal(isToolAllowed(locked, "read"), true);
  assert.equal(isToolAllowed(locked, "write_file"), false);
  assert.equal(isToolAllowed(locked, "bash"), false);
  assert.equal(isToolAllowed(locked, "web_search"), false);
  assert.match(toolDenialReason(locked, "write_file") ?? "", /read-only/);
  assert.match(toolDenialReason(locked, "bash") ?? "", /execute commands/);
  assert.match(toolDenialReason(locked, "web_search") ?? "", /network/);
});

test("clampedMaxTokens and clampedTurnTimeoutMs", () => {
  const role: RoleClamp = { id: "r", modelConfig: { maxTokens: 4096, turnTimeoutMs: 5_000 } };
  assert.equal(clampedMaxTokens(role, 8192), 4096);
  assert.equal(clampedMaxTokens(undefined, 8192), 8192);
  assert.equal(clampedTurnTimeoutMs(role, 30_000), 5_000);
  assert.equal(clampedTurnTimeoutMs({ id: "r", modelConfig: { turnTimeoutMs: 5_000 } }, undefined), 5_000);
  assert.equal(clampedTurnTimeoutMs(undefined, 30_000), 30_000);
  assert.equal(clampedTurnTimeoutMs(undefined, undefined), undefined);
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

test("applyRoleToRunRequest keeps the request unchanged when the whitelist allows all tools", () => {
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