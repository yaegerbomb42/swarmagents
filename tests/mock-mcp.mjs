#!/usr/bin/env node
// Minimal stdio MCP server for tests: tools "echo" and "add". Run by Swarm through a "Local command" connection:
//   command: node   args: <repo>/tests/mock-mcp.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "swarm-mock-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo text back, prefixed with mcp-echo:", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  if (req.params.name === "echo") return { content: [{ type: "text", text: `mcp-echo:${args.text}${process.env.MOCK_MCP_SECRET ? " (secret set)" : ""} (ref ${process.env.MOCK_REF === "tool-secret-5678" ? "ok" : "missing"}) (leak ${process.env.E2E_SERVER_CANARY || process.env.SWARM_E2E_CANARY || process.env.MOCK_SERVICE_KEY ? "YES" : "no"})` }] };
  if (req.params.name === "add") return { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] };
  return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
