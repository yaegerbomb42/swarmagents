import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMcpConfigContent } from "./discovery/mcp-configs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

describe("MCP config parsers", () => {
  it("parses Claude Desktop config and skips disabled servers", async () => {
    const raw = await fs.readFile(path.join(FIXTURES, "claude-desktop.json"), "utf8");
    const servers = parseMcpConfigContent(raw, "claude-desktop", "claude_desktop_config.json");
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, "filesystem");
    assert.equal(servers[0]?.transport, "stdio");
    assert.equal(servers[0]?.command, "npx");
    assert.deepEqual(servers[0]?.args, ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
  });

  it("parses VS Code HTTP MCP config", async () => {
    const raw = await fs.readFile(path.join(FIXTURES, "vscode-mcp.json"), "utf8");
    const servers = parseMcpConfigContent(raw, "vscode", "mcp.json");
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, "remote-docs");
    assert.equal(servers[0]?.transport, "http");
    assert.equal(servers[0]?.url, "https://mcp.example.com/sse");
  });

  it("parses OpenCode array-command MCP config", async () => {
    const raw = await fs.readFile(path.join(FIXTURES, "opencode.json"), "utf8");
    const servers = parseMcpConfigContent(raw, "opencode", "opencode.json");
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, "local-git");
    assert.equal(servers[0]?.transport, "stdio");
    assert.equal(servers[0]?.command, "uvx");
    assert.deepEqual(servers[0]?.args, ["mcp-server-git"]);
  });
});
