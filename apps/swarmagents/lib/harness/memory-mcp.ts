/**
 * The long-term memory MCP server that runs inside the user's VM.
 *
 * The agent's claude process spawns this stdio MCP server (the `memory`
 * entry in the run's --mcp-config) and calls three tools:
 *
 *   - memory_write(fact, tags?)  — remember a durable fact
 *   - memory_search(query, k?)   — recall the facts relevant to a query
 *   - memory_forget(id)          — drop one stored fact
 *
 * The memories themselves live on the host, in the app's per-user data
 * directory — never in the VM. The server therefore does not keep a store:
 * it hands the call to the host over a tiny file-based RPC (a request file
 * in the VM's ephemeral /tmp, answered by the host-side bridge) and returns
 * the host's answer to the agent.
 *
 * Before a call leaves the VM, secret-shaped strings are scrubbed with the
 * same patterns the host redactor uses, so a key the agent was told never
 * even crosses the VM boundary.
 */

import { secretPatternSources } from "./redact";
import {
  MEMORY_FORGET_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_VM_DIR,
  MEMORY_WRITE_TOOL,
} from "../memory/types";

/** Name of the stdio MCP server exposing the memory tools. */
export const MEMORY_MCP_SERVER_NAME = "memory";
/** Where the server script is written inside the user's VM. */
export const MEMORY_MCP_SERVER_PATH = "/workspace/.swarm/memory-server.mjs";
/**
 * The RPC directory inside the VM. It lives in /tmp on purpose: the container
 * filesystem is ephemeral, so a VM reset leaves no trace of the memory.
 */
export const MEMORY_MCP_DIR = MEMORY_VM_DIR;
/** How long the in-VM server waits for the host to answer a call. */
export const MEMORY_MCP_TIMEOUT_MS = 60_000;
/** How often the in-VM server checks for the host's answer. */
export const MEMORY_MCP_POLL_MS = 120;

/** Does this tool-call name belong to the memory server? */
export function isMemoryTool(name: string): boolean {
  return (
    name === MEMORY_WRITE_TOOL ||
    name === MEMORY_SEARCH_TOOL ||
    name === MEMORY_FORGET_TOOL ||
    name.endsWith(`__${MEMORY_WRITE_TOOL}`) ||
    name.endsWith(`__${MEMORY_SEARCH_TOOL}`) ||
    name.endsWith(`__${MEMORY_FORGET_TOOL}`)
  );
}

/** The --mcp-config entry for the memory server. */
export function memoryMcpServerEntry(
  opts: { serverPath?: string; dir?: string } = {},
): Record<string, unknown> {
  return {
    type: "stdio",
    command: "node",
    args: [opts.serverPath ?? MEMORY_MCP_SERVER_PATH],
    env: {
      SWARM_MEMORY_DIR: opts.dir ?? MEMORY_MCP_DIR,
      SWARM_MEMORY_TIMEOUT_MS: String(MEMORY_MCP_TIMEOUT_MS),
      SWARM_MEMORY_POLL_MS: String(MEMORY_MCP_POLL_MS),
    },
  };
}

/** The secret-scrubbing code injected into the in-VM server. */
function scrubSource(): string {
  const patterns = secretPatternSources()
    .map(
      (p) =>
        `  { pattern: new RegExp(${JSON.stringify(p.source)}, ${JSON.stringify(p.flags)}), replacement: ${JSON.stringify(p.replacement)} },`,
    )
    .join("\n");
  return [
    "const SECRET_PATTERNS = [",
    patterns,
    "];",
    "",
    "function scrub(value) {",
    "  if (typeof value !== \"string\") return value;",
    "  let out = value;",
    "  for (const { pattern, replacement } of SECRET_PATTERNS) out = out.replace(pattern, replacement);",
    "  return out;",
    "}",
  ].join("\n");
}

/**
 * The memory MCP server source, written verbatim into the VM.
 *
 * Minimal MCP stdio implementation: newline-delimited JSON-RPC 2.0 on
 * stdin/stdout, exactly like the role-switch server next to it.
 */
export const MEMORY_MCP_SERVER_SOURCE = [
  "#!/usr/bin/env node",
  "// SwarmAgents long-term memory MCP stdio server (auto-generated).",
  "// Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout.",
  "// The store lives on the host: every call is forwarded over a small",
  "// file-based RPC and the host's answer is returned to the agent.",
  "import fs from \"node:fs\";",
  "import path from \"node:path\";",
  "import crypto from \"node:crypto\";",
  "",
  "const dir = process.env.SWARM_MEMORY_DIR || \"/tmp/swarm-memory\";",
  "const timeoutMs = Number(process.env.SWARM_MEMORY_TIMEOUT_MS || \"60000\");",
  "const pollMs = Number(process.env.SWARM_MEMORY_POLL_MS || \"120\");",
  "",
  scrubSource(),
  "",
  "const tools = [",
  "  {",
  "    name: \"memory_write\",",
  "    description: \"Remember a durable fact about this account (a preference, a codebase note, a recurring task pattern). It is stored outside the VM and is injected into future runs. Secrets are redacted before saving.\",",
  "    inputSchema: {",
  "      type: \"object\",",
  "      properties: {",
  "        fact: { type: \"string\", description: \"The fact to remember, one or two short sentences.\" },",
  "        tags: {",
  "          type: \"array\",",
  "          items: { type: \"string\" },",
  "          description: \"Optional tags, e.g. \\\"preference\\\", \\\"codebase:<repoHash>\\\", \\\"task-pattern\\\".\"",
  "        }",
  "      },",
  "      required: [\"fact\"]",
  "    }",
  "  },",
  "  {",
  "    name: \"memory_search\",",
  "    description: \"Look up the account's long-term memories that are relevant to a query. Returns the best matches, most relevant first.\",",
  "    inputSchema: {",
  "      type: \"object\",",
  "      properties: {",
  "        query: { type: \"string\", description: \"What to look for.\" },",
  "        k: { type: \"number\", description: \"How many memories to return (default 5).\" }",
  "      },",
  "      required: [\"query\"]",
  "    }",
  "  },",
  "  {",
  "    name: \"memory_forget\",",
  "    description: \"Forget one stored memory by id (use memory_search to find the id).\",",
  "    inputSchema: {",
  "      type: \"object\",",
  "      properties: { id: { type: \"string\", description: \"The id of the memory to remove.\" } },",
  "      required: [\"id\"]",
  "    }",
  "  }",
  "];",
  "",
  "function sleep(ms) {",
  "  return new Promise((resolve) => setTimeout(resolve, ms));",
  "}",
  "",
  "function toolResult(payload, isError) {",
  "  return {",
  "    content: [{ type: \"text\", text: JSON.stringify(payload) }],",
  "    isError: isError === true",
  "  };",
  "}",
  "",
  "/** Ask the host to run one memory tool and wait for its answer. */",
  "async function callHost(tool, args) {",
  "  const id = crypto.randomBytes(8).toString(\"hex\");",
  "  const requestPath = path.join(dir, `req-${id}.json`);",
  "  const responsePath = path.join(dir, `res-${id}.json`);",
  "  try {",
  "    fs.mkdirSync(dir, { recursive: true });",
  "  } catch (err) {",
  "    return { ok: false, error: \"unavailable\", message: \"Could not reach the memory service.\" };",
  "  }",
  "  const payload = { id: id, tool: tool, args: scrubArgs(args) };",
  "  try {",
  "    fs.writeFileSync(requestPath, JSON.stringify(payload));",
  "  } catch (err) {",
  "    return { ok: false, error: \"unavailable\", message: \"Could not reach the memory service.\" };",
  "  }",
  "  const deadline = Date.now() + timeoutMs;",
  "  while (Date.now() < deadline) {",
  "    if (fs.existsSync(responsePath)) {",
  "      let raw = \"\";",
  "      try { raw = fs.readFileSync(responsePath, \"utf8\"); } catch (err) { raw = \"\"; }",
  "      try { fs.unlinkSync(responsePath); } catch (err) {}",
  "      try {",
  "        return JSON.parse(raw);",
  "      } catch (err) {",
  "        return { ok: false, error: \"bad_response\", message: \"The memory service returned an unreadable answer.\" };",
  "      }",
  "    }",
  "    await sleep(pollMs);",
  "  }",
  "  try { fs.unlinkSync(requestPath); } catch (err) {}",
  "  return { ok: false, error: \"timeout\", message: \"The memory service did not answer in time.\" };",
  "}",
  "",
  "/** Scrub secret-shaped strings out of the arguments before they leave the VM. */",
  "function scrubArgs(args) {",
  "  if (!args || typeof args !== \"object\") return {};",
  "  const out = {};",
  "  for (const [key, value] of Object.entries(args)) {",
  "    if (typeof value === \"string\") out[key] = scrub(value);",
  "    else if (Array.isArray(value)) out[key] = value.map((item) => (typeof item === \"string\" ? scrub(item) : item));",
  "    else out[key] = value;",
  "  }",
  "  return out;",
  "}",
  "",
  "function reply(id, result) {",
  "  process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: id, result: result }) + \"\\n\");",
  "}",
  "",
  "function replyError(id, code, message) {",
  "  process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: id, error: { code: code, message: message } }) + \"\\n\");",
  "}",
  "",
  "async function handleMessage(msg) {",
  "  if (!msg || typeof msg !== \"object\") return;",
  "  const hasId = msg.id !== undefined && msg.id !== null;",
  "  const method = typeof msg.method === \"string\" ? msg.method : \"\";",
  "  if (method === \"initialize\") {",
  "    if (hasId) reply(msg.id, {",
  "      protocolVersion: (msg.params && msg.params.protocolVersion) || \"2024-11-05\",",
  "      capabilities: { tools: {} },",
  "      serverInfo: { name: \"swarm-memory\", version: \"1.0.0\" }",
  "    });",
  "    return;",
  "  }",
  "  if (method === \"ping\") {",
  "    if (hasId) reply(msg.id, {});",
  "    return;",
  "  }",
  "  if (method === \"tools/list\") {",
  "    if (hasId) reply(msg.id, { tools: tools });",
  "    return;",
  "  }",
  "  if (method === \"tools/call\") {",
  "    if (!hasId) return;",
  "    const params = msg.params && typeof msg.params === \"object\" ? msg.params : {};",
  "    const name = typeof params.name === \"string\" ? params.name : \"\";",
  "    const args = params.arguments && typeof params.arguments === \"object\" ? params.arguments : {};",
  "    if (!tools.some((tool) => tool.name === name)) {",
  "      reply(msg.id, toolResult({ ok: false, error: \"unknown_tool\", message: \"Unknown tool: \" + name }, true));",
  "      return;",
  "    }",
  "    const answer = await callHost(name, args);",
  "    reply(msg.id, toolResult(answer, answer && answer.ok !== true));",
  "    return;",
  "  }",
  "  if (method === \"notifications/initialized\" || method === \"notifications/cancelled\") return;",
  "  if (hasId) replyError(msg.id, -32601, \"Method not found: \" + method);",
  "}",
  "",
  "process.stdin.setEncoding(\"utf8\");",
  "let buffer = \"\";",
  "process.stdin.on(\"data\", (chunk) => {",
  "  buffer += chunk;",
  "  let newline;",
  "  while ((newline = buffer.indexOf(\"\\n\")) !== -1) {",
  "    const line = buffer.slice(0, newline).trim();",
  "    buffer = buffer.slice(newline + 1);",
  "    if (!line) continue;",
  "    let msg;",
  "    try { msg = JSON.parse(line); } catch (err) { continue; }",
  "    void handleMessage(msg);",
  "  }",
  "});",
  "",
  "process.stdin.on(\"end\", () => {});",
  "",
].join("\n");
