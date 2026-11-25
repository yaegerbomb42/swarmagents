import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toolForgeMcpServerSource } from "./tool-forge-mcp";

test("tool-forge MCP server searches catalog, authors + smoke-tests a custom tool, and manages it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tool-forge-"));
  try {
    const serverPath = path.join(tmp, "tool-forge-server.mjs");
    const catalogPath = path.join(tmp, "tool-catalog.json");
    const customDir = path.join(tmp, "custom-tools");
    const mcpPath = path.join(tmp, "mcp.json");
    const atlasPath = path.join(tmp, "atlas.json");

    fs.writeFileSync(serverPath, toolForgeMcpServerSource(), "utf8");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify([
        { id: "slack", name: "Slack", category: "apps-productivity", oneClick: false, summary: "Post messages and read channels." },
        { id: "exa", name: "Exa", category: "search-data", oneClick: true, summary: "Neural web search." },
      ]),
      "utf8",
    );
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }), "utf8");
    fs.writeFileSync(atlasPath, JSON.stringify({ schema: "swarm.capability-atlas", entries: [] }), "utf8");

    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_mcp_catalog", arguments: { query: "slack" } } },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "author_tool",
          arguments: {
            id: "echo-upper",
            name: "Echo Upper",
            description: "Uppercases its input string.",
            runtime: "node",
            code: 'console.log((process.env.SWARM_TOOL_INPUT || "").toUpperCase());',
            testArgs: "hello",
          },
        },
      },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "manage_mcp", arguments: { action: "disable", id: "echo-upper" } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_my_tools", arguments: {} } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "install_online_skill", arguments: { id: "../etc/passwd" } } },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n";

    const res = spawnSync("node", [serverPath], {
      input: messages,
      encoding: "utf8",
      env: {
        ...process.env,
        SWARM_TOOL_CATALOG: catalogPath,
        SWARM_CUSTOM_TOOLS_DIR: customDir,
        SWARM_MCP_CONFIG: mcpPath,
        SWARM_ATLAS_REGISTRY: atlasPath,
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const replies = res.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: number; error?: { message?: string }; result?: { content?: Array<{ text: string }>; tools?: unknown[] } });

    assert.equal(replies.find((r) => r.id === 2)?.result?.tools?.length, 6);
    assert.match(replies.find((r) => r.id === 3)?.result?.content?.[0]?.text ?? "", /slack \|/);
    assert.match(replies.find((r) => r.id === 4)?.result?.content?.[0]?.text ?? "", /HELLO/);
    assert.match(replies.find((r) => r.id === 5)?.result?.content?.[0]?.text ?? "", /disabled/);
    assert.match(replies.find((r) => r.id === 6)?.result?.content?.[0]?.text ?? "", /echo-upper\[off\]/);
    assert.match(replies.find((r) => r.id === 7)?.error?.message ?? "", /Invalid skill id/);

    const atlas = JSON.parse(fs.readFileSync(atlasPath, "utf8")) as { entries: Array<{ id: string }> };
    assert.ok(atlas.entries.some((e) => e.id === "custom:echo-upper"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
