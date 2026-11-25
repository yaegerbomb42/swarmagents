/**
 * Agent Self-Authoring Tool & MCP Forge (lib/self-manage/tool-author.ts).
 *
 * Lets agents author, syntax-validate, secret-scan, and package custom
 * Node / Python / Bash tools into self-contained stdio MCP servers that
 * register into the user's per-account Library store and persist across runs.
 */

import { containsSecretValue } from "../agents/export-secrets";
import { CONNECTOR_CATALOG } from "../connectors/catalog";
import { addInstalledItem, type InstalledItemView } from "../library/user-store";

export type ToolRuntime = "node" | "python" | "bash";

export interface AuthorToolInput {
  id: string;
  name: string;
  description: string;
  runtime: ToolRuntime;
  code: string;
  argsDescription?: string;
}

export interface CompactCatalogRow {
  id: string;
  name: string;
  category: string;
  oneClick: boolean;
  summary: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,48}$/;
const MAX_CODE_BYTES = 64 * 1024;

export class ToolAuthorError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ToolAuthorError";
    this.status = status;
  }
}

export function validateAuthorToolInput(input: AuthorToolInput): {
  id: string;
  name: string;
  description: string;
  runtime: ToolRuntime;
  code: string;
  argsDescription: string;
} {
  const id = (input.id ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(id)) {
    throw new ToolAuthorError(
      "Tool id must be 2-49 lowercase letters, digits, '-' or '_'.",
      400,
    );
  }
  const name = (input.name ?? "").trim();
  if (name.length < 2 || name.length > 80) {
    throw new ToolAuthorError("Tool name must be 2-80 characters.", 400);
  }
  const description = (input.description ?? "").trim();
  if (description.length < 6 || description.length > 280) {
    throw new ToolAuthorError("Tool description must be 6-280 characters.", 400);
  }
  if (input.runtime !== "node" && input.runtime !== "python" && input.runtime !== "bash") {
    throw new ToolAuthorError("Runtime must be 'node', 'python', or 'bash'.", 400);
  }
  const code = input.code ?? "";
  if (code.trim().length === 0) {
    throw new ToolAuthorError("Tool code cannot be empty.", 400);
  }
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    throw new ToolAuthorError("Tool code exceeds 64 KB limit.", 400);
  }
  if (containsSecretValue(code)) {
    throw new ToolAuthorError(
      "Tool code contains secret-shaped credentials; use environment variables instead.",
      400,
    );
  }
  const argsDescription = (input.argsDescription ?? "JSON input object passed via SWARM_TOOL_INPUT env and argv[1].")
    .trim()
    .slice(0, 200);
  return { id, name, description, runtime: input.runtime, code, argsDescription };
}

export function scriptFilenameFor(runtime: ToolRuntime): string {
  if (runtime === "python") return "tool.py";
  if (runtime === "bash") return "tool.sh";
  return "tool.mjs";
}

export function runnerCommandFor(runtime: ToolRuntime): string {
  if (runtime === "python") return "python3";
  if (runtime === "bash") return "bash";
  return "node";
}

/**
 * Generates a self-contained Node stdio MCP server wrapper that exposes the
 * authored tool (`<id>`) over JSON-RPC 2.0 `initialize` / `tools/list` / `tools/call`.
 */
export function generateCustomToolMcpWrapper(spec: {
  id: string;
  name: string;
  description: string;
  runtime: ToolRuntime;
  scriptPath: string;
  argsDescription: string;
}): string {
  const cmd = runnerCommandFor(spec.runtime);
  return `import { execFileSync } from "node:child_process";
import readline from "node:readline";

const TOOL_NAME = ${JSON.stringify(spec.id)};
const TOOL_DESC = ${JSON.stringify(spec.description)};
const RUNNER = ${JSON.stringify(cmd)};
const SCRIPT = ${JSON.stringify(spec.scriptPath)};

const TOOLS = [
  {
    name: TOOL_NAME,
    description: TOOL_DESC,
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: ${JSON.stringify(spec.argsDescription)},
        },
      },
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

function handle(msg) {
  if (!msg || typeof msg.method !== "string") return;
  const id = msg.id ?? null;
  if (id === null && msg.method !== "initialize") return;

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "custom-" + TOOL_NAME, version: "1.0.0" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method !== "tools/call") {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    return;
  }

  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  if (params.name !== TOOL_NAME) {
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
    return;
  }

  const inputStr = typeof args.input === "string" ? args.input : JSON.stringify(args);
  try {
    const out = execFileSync(RUNNER, [SCRIPT, inputStr], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 512 * 1024,
      env: { ...process.env, SWARM_TOOL_INPUT: inputStr },
    });
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out || "(ok)" }] } });
  } catch (err) {
    const detail = err && typeof err === "object" && "stderr" in err ? String(err.stderr || err.message) : String(err);
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: detail.slice(0, 2000) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    // ignore malformed json lines
  }
});
`;
}

/**
 * Registers an agent-authored custom tool/MCP server in the user's Library store
 * so it is persisted across trajectories and automatically seeded into --mcp-config.
 */
export function registerAuthoredToolInLibrary(
  userId: string,
  input: AuthorToolInput,
  vmDir = "/workspace/.swarm/custom-tools",
): InstalledItemView {
  const clean = validateAuthorToolInput(input);
  const mcpServerPath = `${vmDir}/${clean.id}/mcp-server.mjs`;
  return addInstalledItem(userId, {
    id: `custom-${clean.id}`,
    kind: "connector",
    name: clean.name,
    description: clean.description,
    payload: {
      kind: "connector",
      transport: "stdio",
      command: "node",
      args: [mcpServerPath],
      requiredFields: [],
      tools: [clean.id],
    },
    secrets: {},
    origin: "agent",
  });
}

/** Compact catalog payload seeded into VM (/workspace/.swarm/tool-catalog.json). */
export function compactConnectorCatalog(): CompactCatalogRow[] {
  return CONNECTOR_CATALOG.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    oneClick: c.fields.length === 0,
    summary: c.unlocks.slice(0, 140),
  }));
}
