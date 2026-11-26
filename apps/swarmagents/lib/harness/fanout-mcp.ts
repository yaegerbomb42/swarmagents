/**
 * fan_out_workers MCP plumbing for bounded parallel wide-research sub-workers.
 *
 * Mirrors ask-mcp.ts / desktop-handoff-mcp.ts: an MCP stdio server seeded into
 * the VM at FANOUT_MCP_SERVER_PATH writes a pending fan-out request into
 * FANOUT_DIR and polls for the aggregated result file written back by the host
 * runtime/executor.
 */

export const FANOUT_MCP_SERVER_NAME = "fanout";
export const FANOUT_WORKERS_TOOL = "fan_out_workers";
export const FANOUT_MCP_SERVER_PATH = "/workspace/.swarm/fanout-server.mjs";
export const FANOUT_DIR = "/workspace/.swarm/fanout";

export const MAX_FANOUT_WORKERS = 5;
export const DEFAULT_WORKER_MAX_TURNS = 6;
export const MAX_WORKER_TURNS = 15;
export const FANOUT_TTL_MS = 10 * 60 * 1000;

export interface FanOutTaskInput {
  id: string;
  prompt: string;
  maxTurns: number;
  roleId?: string;
}

export interface FanOutArguments {
  tasks: FanOutTaskInput[];
  maxConcurrency: number;
  maxTurnsPerWorker: number;
}

/** True when `toolName` refers to the `fan_out_workers` MCP tool. */
export function isFanOutWorkersTool(toolName: string): boolean {
  return (
    toolName === `mcp__${FANOUT_MCP_SERVER_NAME}__${FANOUT_WORKERS_TOOL}` ||
    toolName === FANOUT_WORKERS_TOOL ||
    toolName.endsWith(`__${FANOUT_WORKERS_TOOL}`)
  );
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

/**
 * Parse and bound `fan_out_workers` arguments.
 * Enforces max 5 sub-workers and strict per-worker turn caps.
 * Returns null if no valid task prompts are present.
 */
export function parseFanOutArguments(input: unknown): FanOutArguments | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.tasks)) return null;

  const defaultTurns = clampInt(record.maxTurnsPerWorker, DEFAULT_WORKER_MAX_TURNS, 1, MAX_WORKER_TURNS);
  const maxConcurrency = clampInt(record.maxConcurrency, MAX_FANOUT_WORKERS, 1, MAX_FANOUT_WORKERS);

  const tasks: FanOutTaskInput[] = [];
  for (let i = 0; i < record.tasks.length && tasks.length < MAX_FANOUT_WORKERS; i++) {
    const rawTask = record.tasks[i];
    if (!rawTask || typeof rawTask !== "object") continue;
    const t = rawTask as Record<string, unknown>;
    const prompt = typeof t.prompt === "string" ? t.prompt.trim().slice(0, 8000) : "";
    if (!prompt) continue;
    const id =
      typeof t.id === "string" && t.id.trim()
        ? t.id.trim().slice(0, 48).replace(/[^a-zA-Z0-9._-]/g, "_")
        : `w${tasks.length + 1}`;
    const maxTurns = clampInt(t.maxTurns, defaultTurns, 1, MAX_WORKER_TURNS);
    const roleId = typeof t.roleId === "string" && t.roleId.trim() ? t.roleId.trim().slice(0, 64) : undefined;
    tasks.push({ id, prompt, maxTurns, ...(roleId ? { roleId } : {}) });
  }

  if (tasks.length === 0) return null;
  return { tasks, maxConcurrency: Math.min(maxConcurrency, tasks.length), maxTurnsPerWorker: defaultTurns };
}

/** VM paths for a fan-out request's pending and aggregated result files. */
export function fanOutPaths(id: string): { pending: string; result: string } {
  return {
    pending: `${FANOUT_DIR}/${id}.pending.json`,
    result: `${FANOUT_DIR}/${id}.result.json`,
  };
}

/**
 * MCP stdio server source, written into the VM as FANOUT_MCP_SERVER_PATH.
 */
export const FANOUT_MCP_SERVER_SOURCE = [
  "#!/usr/bin/env node",
  "// SwarmAgents fan_out_workers MCP stdio server (auto-generated).",
  "import fs from \"node:fs\";",
  "import path from \"node:path\";",
  "import { randomUUID } from \"node:crypto\";",
  "",
  "const dir = process.env.SWARM_FANOUT_DIR || \"/workspace/.swarm/fanout\";",
  "const ttlMs = Number(process.env.SWARM_FANOUT_TIMEOUT_MS) > 0 ? Number(process.env.SWARM_FANOUT_TIMEOUT_MS) : 600000;",
  "",
  "const tools = [{",
  "  name: \"fan_out_workers\",",
  "  description: \"Run up to 5 bounded parallel research/audit sub-workers and return all structured findings in one aggregated result.\",",
  "  inputSchema: {",
  "    type: \"object\",",
  "    properties: {",
  "      tasks: {",
  "        type: \"array\",",
  "        maxItems: 5,",
  "        items: {",
  "          type: \"object\",",
  "          properties: {",
  "            id: { type: \"string\" },",
  "            prompt: { type: \"string\" },",
  "            maxTurns: { type: \"number\" },",
  "            roleId: { type: \"string\" }",
  "          },",
  "          required: [\"prompt\"]",
  "        }",
  "      },",
  "      maxConcurrency: { type: \"number\", minimum: 1, maximum: 5 },",
  "      maxTurnsPerWorker: { type: \"number\", minimum: 1, maximum: 15 }",
  "    },",
  "    required: [\"tasks\"]",
  "  }",
  "}];",
  "",
  "function send(msg) { process.stdout.write(JSON.stringify(msg) + \"\\n\"); }",
  "",
  "async function callTool(id, params) {",
  "  if (params?.name !== \"fan_out_workers\") {",
  "    return send({ jsonrpc: \"2.0\", id, error: { code: -32601, message: \"Unknown tool\" } });",
  "  }",
  "  const reqId = \"fan_\" + randomUUID();",
  "  fs.mkdirSync(dir, { recursive: true });",
  "  const pending = path.join(dir, reqId + \".pending.json\");",
  "  const resultFile = path.join(dir, reqId + \".result.json\");",
  "  fs.writeFileSync(pending, JSON.stringify({ id: reqId, args: params.arguments ?? {}, createdAt: Date.now() }));",
  "  const deadline = Date.now() + ttlMs;",
  "  while (Date.now() < deadline) {",
  "    if (fs.existsSync(resultFile)) {",
  "      const text = fs.readFileSync(resultFile, \"utf8\");",
  "      try { fs.unlinkSync(pending); } catch {}",
  "      try { fs.unlinkSync(resultFile); } catch {}",
  "      return send({ jsonrpc: \"2.0\", id, result: { content: [{ type: \"text\", text }] } });",
  "    }",
  "    await new Promise((r) => setTimeout(r, 150));",
  "  }",
  "  try { fs.unlinkSync(pending); } catch {}",
  "  return send({ jsonrpc: \"2.0\", id, result: { isError: true, content: [{ type: \"text\", text: JSON.stringify({ ok: false, error: \"fan_out_workers timed out\" }) }] } });",
  "}",
  "",
  "let buf = \"\";",
  "process.stdin.setEncoding(\"utf8\");",
  "process.stdin.on(\"data\", async (chunk) => {",
  "  buf += chunk;",
  "  for (;;) {",
  "    const nl = buf.indexOf(\"\\n\");",
  "    if (nl < 0) break;",
  "    const line = buf.slice(0, nl).trim();",
  "    buf = buf.slice(nl + 1);",
  "    if (!line) continue;",
  "    let msg; try { msg = JSON.parse(line); } catch { continue; }",
  "    if (msg.method === \"initialize\") {",
  "      send({ jsonrpc: \"2.0\", id: msg.id, result: { protocolVersion: \"2024-11-05\", capabilities: { tools: {} }, serverInfo: { name: \"fanout\", version: \"1.0.0\" } } });",
  "    } else if (msg.method === \"tools/list\") {",
  "      send({ jsonrpc: \"2.0\", id: msg.id, result: { tools } });",
  "    } else if (msg.method === \"tools/call\") {",
  "      void callTool(msg.id, msg.params);",
  "    }",
  "  }",
  "});",
  "",
].join("\n");
