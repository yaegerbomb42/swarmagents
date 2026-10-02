import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { currentUser, mcpConfig } from "../store";
import { onMcpChange, transportFor } from "../connections";
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
  // Claude Code / Desktop servers are the machine owner's: only the local user gets them, never server accounts.
  const host = currentUser() === "local" ? [path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json"), path.join(os.homedir(), ".claude.json")] : [];
  const sources = [...host, mcpConfig()];
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
const g = globalThis as unknown as { __swarmMcpConns?: Map<string, Promise<Conn | null>>; __swarmMcpStatus?: Record<string, string> };
const conns = (g.__swarmMcpConns ??= new Map<string, Promise<Conn | null>>());
export const mcpStatus: Record<string, string> = (g.__swarmMcpStatus ??= {});

// Live connections and their status are per account: key = "<user>\u0000<server name>".
const keyFor = (name: string, user = currentUser()) => `${user}\u0000${name}`;
/** Status line for one of the current user's servers ("connected (5 tools)", "failed: …"). */
export const mcpStatusFor = (name: string) => mcpStatus[keyFor(name)];

/** Drop one of the current user's live connections (or all of them) so the next task reconnects with the edited definition. */
export function resetMcp(name?: string) {
  const prefix = keyFor("");
  for (const [n, p] of conns) {
    if (!n.startsWith(prefix) || (name && n !== keyFor(name))) continue;
    conns.delete(n);
    delete mcpStatus[n];
    void p.then((c) => c?.client.close()).catch(() => {});
  }
}
onMcpChange(resetMcp);

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);

async function connect(name: string, def: ServerDef, key: string): Promise<Conn | null> {
  try {
    const client = new Client({ name: "swarmagents", version: "2.0.0" });
    // Remote servers get stored OAuth tokens (auto-refreshed); stdio servers also see the user's tool keys as env.
    const transport = transportFor(name, def);
    await Promise.race([client.connect(transport), new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout")), 20_000))]);
    const { tools } = await client.listTools();
    mcpStatus[key] = `connected (${tools.length} tools)`;
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
    mcpStatus[key] = `failed: ${(e as Error).message}`;
    return null;
  }
}

export async function mcpTools(): Promise<Tool[]> {
  const defs = configured();
  const prefix = keyFor("");
  const out = await Promise.all(
    Object.entries(defs).map(([name, def]) => {
      const key = keyFor(name);
      if (!conns.has(key)) conns.set(key, connect(name, def, key));
      return conns.get(key)!;
    }),
  );
  // Retry failed servers on the next task rather than caching the failure forever (this user's entries only).
  for (const [key, p] of conns) if (key.startsWith(prefix) && (!(key.slice(prefix.length) in defs) || !(await p))) conns.delete(key);
  return out.flatMap((c) => c?.tools ?? []);
}
