import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { MCP_CONFIG } from "../store";
import { clip, type Tool } from "./types";

// Connectors are standard MCP servers. We read ~/.swarmagents/mcp.json and also pick up servers the
// user already configured for Claude Code / Claude Desktop, so existing connectors work with zero setup.

interface ServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  disabled?: boolean;
}

function configured(): Record<string, ServerDef> {
  const sources = [
    path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json"),
    path.join(os.homedir(), ".claude.json"),
    MCP_CONFIG,
  ];
  const all: Record<string, ServerDef> = {};
  for (const f of sources) {
    try {
      Object.assign(all, JSON.parse(fs.readFileSync(f, "utf8")).mcpServers ?? {});
    } catch {}
  }
  return Object.fromEntries(Object.entries(all).filter(([, d]) => !d.disabled));
}

interface Conn {
  client: Client;
  tools: Tool[];
}
const conns = new Map<string, Promise<Conn | null>>();
export const mcpStatus: Record<string, string> = {};

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);

async function connect(name: string, def: ServerDef): Promise<Conn | null> {
  try {
    const client = new Client({ name: "swarmagents", version: "2.0.0" });
    const transport = def.url
      ? def.type === "sse"
        ? new SSEClientTransport(new URL(def.url), { requestInit: { headers: def.headers } })
        : new StreamableHTTPClientTransport(new URL(def.url), { requestInit: { headers: def.headers } })
      : new StdioClientTransport({ command: def.command!, args: def.args ?? [], env: { ...(process.env as Record<string, string>), ...def.env }, stderr: "ignore" });
    await Promise.race([client.connect(transport), new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout")), 20_000))]);
    const { tools } = await client.listTools();
    mcpStatus[name] = `connected (${tools.length} tools)`;
    return {
      client,
      tools: tools.map((t) => ({
        spec: { name: `mcp__${safe(name)}__${safe(t.name)}`.slice(0, 64), description: `[${name}] ${t.description ?? ""}`.slice(0, 1024), schema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" } },
        async run(input, ctx) {
          const r = await client.callTool({ name: t.name, arguments: input }, undefined, { signal: ctx.signal, timeout: 10 * 60_000 });
          const content = (r.content as { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }[]) ?? [];
          return {
            content: clip(content.map((c) => c.text ?? c.resource?.text ?? (c.resource?.uri ? `[resource ${c.resource.uri}]` : c.type === "image" ? "[image]" : "")).join("\n") || JSON.stringify(r.structuredContent ?? r), 40_000),
            images: content.filter((c) => c.type === "image" && c.data).map((c) => ({ mediaType: c.mimeType ?? "image/png", data: c.data! })),
            isError: !!r.isError,
          };
        },
      })),
    };
  } catch (e) {
    mcpStatus[name] = `failed: ${(e as Error).message}`;
    return null;
  }
}

export async function mcpTools(): Promise<Tool[]> {
  const defs = configured();
  const out = await Promise.all(
    Object.entries(defs).map(([name, def]) => {
      if (!conns.has(name)) conns.set(name, connect(name, def));
      return conns.get(name)!;
    }),
  );
  // Retry failed servers on the next task rather than caching the failure forever.
  for (const [name, p] of conns) if (!(name in defs) || !(await p)) conns.delete(name);
  return out.flatMap((c) => c?.tools ?? []);
}
