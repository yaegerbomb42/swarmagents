import { spawn, type SpawnOptions } from "node:child_process";
import type { CapabilityEntry } from "../schema";
import { truncateSummary } from "../schema";
import { classifyRisk, type McpToolAnnotations } from "../risk";
import type { McpServerConfig } from "./mcp-configs";

export interface McpProbeOptions {
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

interface McpResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
];

function buildSandboxedEnv(
  serverEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  // Next.js types require NODE_ENV on ProcessEnv, so the object carries a
  // default that the allowlist loop below overwrites whenever the parent
  // process actually defines NODE_ENV (never inventing a value it set).
  const nodeEnv = process.env.NODE_ENV;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development",
  };
  for (const k of SAFE_ENV_KEYS) {
    const val = process.env[k];
    if (val !== undefined) env[k] = val;
  }
  if (serverEnv) {
    for (const [k, v] of Object.entries(serverEnv)) {
      env[k] = v;
    }
  }
  return env;
}

function entriesFromMcpLists(
  server: McpServerConfig,
  tools: McpToolDef[],
  resources: McpResourceDef[],
  prompts: McpPromptDef[]
): CapabilityEntry[] {
  const entries: CapabilityEntry[] = [];
  const source = `mcp:${server.client}:${server.name}`;

  for (const tool of tools) {
    const summary = truncateSummary(
      tool.description ?? `MCP tool ${tool.name} on ${server.name}`
    );
    entries.push({
      id: `mcp:${server.name}:tool:${tool.name}`,
      kind: "mcp_tool",
      name: `${server.name}/${tool.name}`,
      summary,
      risk: classifyRisk({
        name: tool.name,
        summary,
        kind: "mcp_tool",
        annotations: tool.annotations,
      }),
      schema: {
        server: server.name,
        tool: tool.name,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        annotations: tool.annotations,
      },
      source,
    });
  }

  for (const res of resources) {
    const label = res.name ?? res.uri;
    const summary = truncateSummary(
      res.description ?? `MCP resource ${res.uri} on ${server.name}`
    );
    entries.push({
      id: `mcp:${server.name}:resource:${encodeURIComponent(res.uri)}`,
      kind: "mcp_resource",
      name: `${server.name}/${label}`,
      summary,
      risk: "read-only",
      schema: {
        server: server.name,
        uri: res.uri,
        mimeType: res.mimeType,
      },
      source,
    });
  }

  for (const prompt of prompts) {
    const summary = truncateSummary(
      prompt.description ?? `MCP prompt ${prompt.name} on ${server.name}`
    );
    entries.push({
      id: `mcp:${server.name}:prompt:${prompt.name}`,
      kind: "mcp_prompt",
      name: `${server.name}/${prompt.name}`,
      summary,
      risk: "read-only",
      schema: {
        server: server.name,
        prompt: prompt.name,
        arguments: prompt.arguments ?? [],
      },
      source,
    });
  }

  return entries;
}

async function probeStdioServer(
  server: McpServerConfig,
  timeoutMs: number
): Promise<CapabilityEntry[]> {
  if (!server.command) return [];

  return new Promise<CapabilityEntry[]>((resolve) => {
    const options: SpawnOptions = {
      env: buildSandboxedEnv(server.env),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    };
    const child = spawn(server.command!, server.args ?? [], options);

    let settled = false;
    let buffer = "";
    const pending = new Map<
      number,
      (res: JsonRpcResponse | null) => void
    >();

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const cb of pending.values()) cb(null);
      pending.clear();
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 250).unref();
      } catch {
        // already exited
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve([]);
    }, timeoutMs);

    child.on("error", () => {
      cleanup();
      resolve([]);
    });

    child.on("exit", () => {
      if (!settled) {
        cleanup();
        resolve([]);
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse;
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            const cb = pending.get(msg.id)!;
            pending.delete(msg.id);
            cb(msg);
          }
        } catch {
          // Ignore non-JSON stdout noise
        }
      }
    });

    let nextId = 1;
    const sendRpc = (
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<JsonRpcResponse | null> =>
      new Promise((res) => {
        if (settled || !child.stdin?.writable) {
          res(null);
          return;
        }
        const id = nextId++;
        pending.set(id, res);
        const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        child.stdin.write(`${payload}\n`);
      });

    const sendNotification = (method: string) => {
      if (settled || !child.stdin?.writable) return;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method })}\n`
      );
    };

    void (async () => {
      const init = await sendRpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "capability-atlas", version: "1.0.0" },
      });
      if (!init || init.error) {
        cleanup();
        resolve([]);
        return;
      }

      sendNotification("notifications/initialized");

      const [toolsRes, resourcesRes, promptsRes] = await Promise.all([
        sendRpc("tools/list"),
        sendRpc("resources/list"),
        sendRpc("prompts/list"),
      ]);

      const tools = Array.isArray(toolsRes?.result?.tools)
        ? (toolsRes!.result!.tools as McpToolDef[])
        : [];
      const resources = Array.isArray(resourcesRes?.result?.resources)
        ? (resourcesRes!.result!.resources as McpResourceDef[])
        : [];
      const prompts = Array.isArray(promptsRes?.result?.prompts)
        ? (promptsRes!.result!.prompts as McpPromptDef[])
        : [];

      const entries = entriesFromMcpLists(server, tools, resources, prompts);
      cleanup();
      resolve(entries);
    })();
  });
}

async function probeHttpServer(
  server: McpServerConfig,
  timeoutMs: number
): Promise<CapabilityEntry[]> {
  if (!server.url) return [];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(server.headers ?? {}),
  };

  let id = 1;
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<JsonRpcResponse | null> => {
    try {
      const res = await fetch(server.url!, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.startsWith("data:")) {
        const firstData = text
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim();
        return firstData ? (JSON.parse(firstData) as JsonRpcResponse) : null;
      }
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      return null;
    }
  };

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "capability-atlas", version: "1.0.0" },
  });
  if (!init || init.error) return [];

  const [toolsRes, resourcesRes, promptsRes] = await Promise.all([
    rpc("tools/list"),
    rpc("resources/list"),
    rpc("prompts/list"),
  ]);

  const tools = Array.isArray(toolsRes?.result?.tools)
    ? (toolsRes!.result!.tools as McpToolDef[])
    : [];
  const resources = Array.isArray(resourcesRes?.result?.resources)
    ? (resourcesRes!.result!.resources as McpResourceDef[])
    : [];
  const prompts = Array.isArray(promptsRes?.result?.prompts)
    ? (promptsRes!.result!.prompts as McpPromptDef[])
    : [];

  return entriesFromMcpLists(server, tools, resources, prompts);
}

export async function probeMcpServer(
  server: McpServerConfig,
  options: McpProbeOptions = {}
): Promise<CapabilityEntry[]> {
  const timeoutMs = options.timeoutMs ?? 4000;
  if (server.transport === "stdio") {
    return probeStdioServer(server, timeoutMs);
  }
  return probeHttpServer(server, timeoutMs);
}
