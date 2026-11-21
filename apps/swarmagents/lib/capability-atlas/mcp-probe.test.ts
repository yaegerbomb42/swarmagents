import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeMcpServer } from "./discovery/mcp-probe";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("MCP sandboxed probe", () => {
  it("times out cleanly on a hanging MCP server", async () => {
    const script = path.join(HERE, "fixtures", "hanging-mcp-server.mjs");
    const start = Date.now();
    const entries = await probeMcpServer(
      {
        name: "hanging",
        client: "claude-desktop",
        sourcePath: "test",
        transport: "stdio",
        command: process.execPath,
        args: [script],
      },
      { timeoutMs: 400 }
    );
    const elapsed = Date.now() - start;

    assert.deepEqual(entries, []);
    assert.ok(elapsed < 2000);
  });
});
