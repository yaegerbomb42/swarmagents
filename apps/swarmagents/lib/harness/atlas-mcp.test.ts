import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAtlasServerSource } from "../capability-atlas/generate-server-source.js";
import {
  ATLAS_DESCRIBE_TOOL,
  ATLAS_FIND_TOOL,
  ATLAS_MCP_SERVER_NAME,
  ATLAS_MCP_SERVER_PATH,
  atlasMcpServerSource,
} from "./atlas-mcp-source.js";
import {
  BUILTIN_ROLES,
  DEFAULT_ROLE_ID,
} from "../roles.js";
import {
  atlasEnabled,
  roleAllowedTools,
  roleMcpConfigJson,
  rolePhase,
  roleSeedFiles,
} from "./role-mcp.js";
import type { RolePhase } from "./types.js";

const mainRole = () => BUILTIN_ROLES.find((role) => role.id === DEFAULT_ROLE_ID)!;
const phaseFor = (roleId: string): RolePhase =>
  rolePhase(BUILTIN_ROLES.find((role) => role.id === roleId)!);

type McpConfig = {
  mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
};

function parseConfig(json: string): McpConfig {
  return JSON.parse(json) as McpConfig;
}

test("atlas: generated server source matches the generator output", () => {
  const checkedIn = fs.readFileSync(
    fileURLToPath(new URL("./atlas-mcp-source.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(checkedIn, buildAtlasServerSource());
  assert.equal(ATLAS_MCP_SERVER_NAME, "capability-atlas");
  assert.equal(ATLAS_MCP_SERVER_PATH, "/workspace/.swarm/atlas-server.mjs");
  assert.equal(ATLAS_FIND_TOOL, "find_capability");
  assert.equal(ATLAS_DESCRIBE_TOOL, "describe_capability");
  const program = atlasMcpServerSource();
  assert.match(program, /find_capability/);
  assert.match(program, /describe_capability/);
  assert.doesNotMatch(program, /zod/);
});

test("atlas: generated server runs under plain node and serves only projected fields", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mcp-"));
  const serverPath = path.join(tmp, "atlas-server.mjs");
  fs.writeFileSync(serverPath, atlasMcpServerSource(), "utf8");
  const registryPath = path.join(tmp, "registry.json");
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      lastRefreshedAt: "2026-11-21T00:00:00.000Z",
      entries: [
        {
          id: "cli:ffmpeg",
          kind: "cli",
          name: "ffmpeg",
          summary: "Render and transcode video files",
          risk: "writes-files",
          source: "cli-scan",
          apiKey: "sk-must-never-appear",
        },
        {
          id: "mcp:filesystem",
          kind: "mcp_tool",
          name: "read_file",
          summary: "Read a file from the workspace",
          risk: "read-only",
          source: "mcp-config",
        },
        { id: "bad-entry", kind: "nonsense", name: "", summary: "x" },
      ],
    }),
    "utf8",
  );
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "find_capability", arguments: { query: "render video" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "describe_capability", arguments: { id: "cli:ffmpeg" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "describe_capability", arguments: { id: "bad-entry" } },
    }),
  ].join("\n");
  const res = spawnSync(process.execPath, [serverPath], {
    input,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, SWARM_ATLAS_REGISTRY: registryPath },
  });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as {
    id: number;
    result?: { content?: Array<{ text: string }> };
    error?: { message: string };
  });
  assert.equal(lines[0]!.result !== undefined, true);
  const list = (lines[1]!.result as unknown as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(
    list.map((t) => t.name).sort(),
    ["describe_capability", "find_capability"],
  );
  const found = lines[2]!.result!.content![0]!.text;
  assert.match(found, /cli:ffmpeg/);
  const described = lines[3]!.result!.content![0]!.text;
  const entry = JSON.parse(described) as Record<string, unknown>;
  assert.deepEqual(Object.keys(entry).sort(), [
    "id",
    "kind",
    "name",
    "risk",
    "source",
    "summary",
  ]);
  assert.doesNotMatch(described, /sk-must-never-appear/);
  assert.equal(lines[4]!.result!.content![0]!.text, "No such capability.");
});

test("atlas: missing registry fails open with an empty result", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mcp-empty-"));
  const serverPath = path.join(tmp, "atlas-server.mjs");
  fs.writeFileSync(serverPath, atlasMcpServerSource(), "utf8");
  const res = spawnSync(process.execPath, [serverPath], {
    input: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "find_capability", arguments: { query: "render" } },
    }),
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, SWARM_ATLAS_REGISTRY: path.join(tmp, "nope.json") },
  });
  assert.equal(res.status, 0, res.stderr);
  const line = JSON.parse(res.stdout.trim()) as {
    result: { content: Array<{ text: string }> };
  };
  assert.equal(line.result.content[0]!.text, "No matching capabilities found.");
});

test("atlasEnabled reads SWARM_ATLAS_ENABLED, default off", () => {
  assert.equal(atlasEnabled({}), false);
  assert.equal(atlasEnabled({ SWARM_ATLAS_ENABLED: "0" }), false);
  assert.equal(atlasEnabled({ SWARM_ATLAS_ENABLED: "1" }), true);
});

test("atlas: config and seed files exclude the server by default, include it when enabled", () => {
  const phase = phaseFor("main");
  const off = parseConfig(
    roleMcpConfigJson(phase, { allowedRoleIds: new Set(["main"]) }),
  );
  assert.equal(ATLAS_MCP_SERVER_NAME in off.mcpServers, false);

  const on = parseConfig(
    roleMcpConfigJson(phase, {
      allowedRoleIds: new Set(["main"]),
      atlasEnabled: true,
    }),
  );
  const entry = on.mcpServers[ATLAS_MCP_SERVER_NAME]!;
  assert.equal(entry.command, "node");
  assert.deepEqual(entry.args, [ATLAS_MCP_SERVER_PATH]);
  assert.equal(entry.env, undefined);

  const withPath = parseConfig(
    roleMcpConfigJson(phase, {
      allowedRoleIds: new Set(["main"]),
      atlasEnabled: true,
      atlasRegistryPath: "/workspace/.swarm/atlas/registry.json",
    }),
  );
  assert.equal(
    withPath.mcpServers[ATLAS_MCP_SERVER_NAME]!.env?.SWARM_ATLAS_REGISTRY,
    "/workspace/.swarm/atlas/registry.json",
  );

  const catalog = BUILTIN_ROLES;
  const offFiles = roleSeedFiles(catalog, new Set(catalog.map((r) => r.id)));
  assert.equal(offFiles.some((f) => f.path === ATLAS_MCP_SERVER_PATH), false);
  const onFiles = roleSeedFiles(catalog, new Set(catalog.map((r) => r.id)), undefined, {
    atlasEnabled: true,
  });
  const serverFile = onFiles.find((f) => f.path === ATLAS_MCP_SERVER_PATH);
  assert.ok(serverFile);
  assert.equal(serverFile.content, atlasMcpServerSource());
  const configFile = onFiles.find((f) => f.path.endsWith("mcp.json"));
  assert.ok(configFile);
  assert.equal(
    ATLAS_MCP_SERVER_NAME in parseConfig(configFile.content).mcpServers,
    true,
  );
});

test("atlas: allowed tools grant the atlas server only when enabled", () => {
  const role = mainRole();
  assert.equal(
    roleAllowedTools(role).includes(`mcp__${ATLAS_MCP_SERVER_NAME}__*`),
    false,
  );
  assert.equal(
    roleAllowedTools(role, { atlasEnabled: true }).includes(`mcp__${ATLAS_MCP_SERVER_NAME}__*`),
    true,
  );
  const phase = rolePhase(role, { atlasEnabled: true });
  assert.ok(phase.allowedTools.includes(`mcp__${ATLAS_MCP_SERVER_NAME}__*`));
});
