import test from "node:test";
import assert from "node:assert/strict";
import { clearMcpRegistryCache, searchMcpRegistry } from "./registry";

test("searchMcpRegistry returns compact summaries and caches results", async () => {
  clearMcpRegistryCache();
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        servers: [
          {
            server: {
              name: "ai.exa/exa",
              description: "Neural web search and clean page extraction.",
              version: "1.0.0",
              remotes: [{ type: "streamable-http", url: "https://mcp.exa.ai/mcp" }],
            },
          },
          {
            server: {
              name: "io.github/sqlite",
              description: "Read-only SQLite MCP server.",
              version: "0.2.0",
              packages: [{ registryType: "npm", identifier: "@mcp/sqlite" }],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const first = await searchMcpRegistry("exa", { limit: 10, fetchImpl: fakeFetch });
  assert.equal(first.length, 2);
  assert.equal(first[0].transport, "http");
  assert.equal(first[0].url, "https://mcp.exa.ai/mcp");
  assert.equal(first[1].transport, "stdio");

  const second = await searchMcpRegistry("exa", { limit: 10, fetchImpl: fakeFetch });
  assert.equal(second.length, 2);
  assert.equal(calls, 1);
});
