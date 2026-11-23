/**
 * Role-wiring tests for the web-search MCP server: it is wired and granted
 * only when a role lists "web-search" in mcpServers, and the default
 * toolset is unchanged (no builtin role gains the tool).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_ROLES, DEFAULT_ROLE_ID, type RoleDefinition } from "../roles";
import { roleAllowedTools, roleMcpConfigJson, rolePhase, roleSeedFiles } from "./role-mcp";
import {
  WEB_SEARCH_MCP_SERVER_NAME,
  WEB_SEARCH_MCP_SERVER_PATH,
  webSearchMcpServerSource,
} from "./web-search-mcp-source";

function defaultRole(): RoleDefinition {
  const role = BUILTIN_ROLES.find((r) => r.id === DEFAULT_ROLE_ID) ?? BUILTIN_ROLES[0];
  assert.ok(role);
  return role;
}

function grantedRole(): RoleDefinition {
  const base = defaultRole();
  return { ...base, mcpServers: [...base.mcpServers, WEB_SEARCH_MCP_SERVER_NAME] };
}

test("the default toolset does not include web search", () => {
  const tools = roleAllowedTools(defaultRole());
  assert.equal(tools.includes(`mcp__${WEB_SEARCH_MCP_SERVER_NAME}__*`), false);

  const config = JSON.parse(
    roleMcpConfigJson(rolePhase(defaultRole()), {
      allowedRoleIds: new Set([defaultRole().id]),
      roleDef: defaultRole(),
    }),
  ) as { mcpServers: Record<string, unknown> };
  assert.equal(WEB_SEARCH_MCP_SERVER_NAME in config.mcpServers, false);
});

test("a role listing web-search gets the server wired and the tools granted", () => {
  const role = grantedRole();
  const tools = roleAllowedTools(role);
  assert.equal(tools.includes(`mcp__${WEB_SEARCH_MCP_SERVER_NAME}__*`), true);

  const config = JSON.parse(
    roleMcpConfigJson(rolePhase(role), {
      allowedRoleIds: new Set([role.id]),
      roleDef: role,
    }),
  ) as { mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }> };
  const entry = config.mcpServers[WEB_SEARCH_MCP_SERVER_NAME];
  assert.ok(entry);
  assert.deepEqual(entry.args, [WEB_SEARCH_MCP_SERVER_PATH]);
  // No secret env by default: the server derives the host route from the
  // run's ANTHROPIC_* env.
  assert.equal(entry.env, undefined);
});

test("an explicit webSearchUrl is passed through as SWARM_WEB_SEARCH_URL", () => {
  const role = grantedRole();
  const config = JSON.parse(
    roleMcpConfigJson(rolePhase(role), {
      allowedRoleIds: new Set([role.id]),
      roleDef: role,
      webSearchUrl: "https://host.example/api/runtime/web/tok/search",
    }),
  ) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  assert.equal(
    config.mcpServers[WEB_SEARCH_MCP_SERVER_NAME]?.env?.SWARM_WEB_SEARCH_URL,
    "https://host.example/api/runtime/web/tok/search",
  );
});

test("the server source is always seeded so a mid-run role switch can wire it", () => {
  const role = defaultRole();
  const files = roleSeedFiles([role], new Set([role.id]), rolePhase(role));
  const seeded = files.find((file) => file.path === WEB_SEARCH_MCP_SERVER_PATH);
  assert.ok(seeded);
  assert.equal(seeded.content, webSearchMcpServerSource());
});
